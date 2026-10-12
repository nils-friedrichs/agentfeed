// tools/launchodds.js — /api/launch-odds and the token-risk "launch" block (R3, 2026-10-12).
//
// SOURCE. /opt/launchledger/launchledger.db, written by LaunchLedger's collector (pm2
// ledger-col, a cycle every 10 minutes). It freezes a Solana pool at discovery (t0), follows
// it only if it crosses a traction threshold (cohort), re-observes it at 1, 7 and 30 days
// and labels each horizon mechanically: lp_removed | liquidity_collapsed | inactive | active
// (unknown and unresolvable are not outcomes and are excluded from the shares).
//
// READ-ONLY, AND NEVER ON THE EVENT LOOP. Every query runs in a `sqlite3 -readonly`
// child process, so a 0.6-1.8 s aggregate over ~530k labels never blocks the server and
// the paid read path cannot write to the ledger. Mints are validated as base58 before
// they reach SQL. No bulk rows: a launchpad answer is aggregate shares, a mint answer is
// that mint's own pools (at most 5). The dataset itself stays LaunchLedger's product.
//
// CONTRACT. An untracked mint is 422 not_tracked (never settled). A ledger whose last
// cycle is more than an hour old answers 503 (never settled).
'use strict';
const { execFile } = require('node:child_process');

const DB_PATH = () => process.env.LAUNCHLEDGER_DB || '/opt/launchledger/launchledger.db';
const SQLITE = () => process.env.SQLITE3_BIN || '/usr/bin/sqlite3';
const AGG_TTL_MS = 15 * 60 * 1000;
const STALE_S = 3600;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const OUTCOMES = ['lp_removed', 'liquidity_collapsed', 'inactive', 'active'];
// t0 liquidity bands (USD). The cohort floor is $5k liquidity OR $1k 24h volume, so the
// first band holds pools that qualified on volume with thin liquidity.
const BANDS = [[0, 5000], [5000, 10000], [10000, 25000], [25000, 50000], [50000, 100000], [100000, 250000], [250000, null]];
const bandCase = `CASE WHEN p.t0_liquidity_usd IS NULL THEN -1 ${BANDS.map(([lo, hi], i) => (hi == null ? `ELSE ${i}` : `WHEN p.t0_liquidity_usd < ${hi} THEN ${i}`)).join(' ')} END`;

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const notTracked = (msg) => Object.assign(new Error(msg), { status: 422, kind: 'bad_request', code: 'not_tracked' });
const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

function query(sql, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(SQLITE(), ['-readonly', '-json', DB_PATH(), sql], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(unavailable(`launch ledger query failed: ${String(err.message || err).split('\n')[0].slice(0, 160)}`));
      const out = String(stdout || '').trim();
      try { resolve(out ? JSON.parse(out) : []); } catch { reject(unavailable('launch ledger answered unreadable output')); }
    });
  });
}

// ---- aggregate: every launchpad x band x horizon x label, one pass, cached ----
let agg = null;       // { at, lastCycle, dex: { [dex]: { followed, cells: {band:{h:{label:n}}} } }, reasons }
let aggInflight = null;
async function buildAgg() {
  const [cells, followed, meta, reasons] = await Promise.all([
    query(`SELECT p.dex AS dex, ${bandCase} AS band, l.horizon_days AS h, l.label AS label, COUNT(*) AS n
           FROM labels l JOIN pools p ON p.id = l.pool_id WHERE p.cohort = 1 GROUP BY 1, 2, 3, 4`, { timeout: 30000 }),
    query(`SELECT dex, ${bandCase.replace(/p\./g, '')} AS band, COUNT(*) AS n FROM pools WHERE cohort = 1 GROUP BY 1, 2`, { timeout: 30000 }),
    query(`SELECT v FROM meta WHERE k = 'last_cycle'`),
    query(`SELECT cohort_reason AS r, COUNT(*) AS n FROM pools WHERE cohort = 1 GROUP BY 1`, { timeout: 30000 }),
  ]);
  const dex = {};
  const slot = (d) => dex[d] || (dex[d] = { followed: {}, cells: {} });
  for (const f of followed) slot(f.dex || 'unknown').followed[f.band] = f.n;
  for (const c of cells) {
    const s = slot(c.dex || 'unknown');
    ((s.cells[c.band] ||= {})[c.h] ||= {})[c.label] = c.n;
  }
  return { at: Date.now(), lastCycle: Number(meta[0] && meta[0].v) || null, dex, reasons };
}
async function getAgg() {
  if (agg && Date.now() - agg.at < AGG_TTL_MS) return agg;
  if (!aggInflight) aggInflight = buildAgg().then((a) => { agg = a; return a; }).finally(() => { aggInflight = null; });
  // a cached aggregate is served while a refresh runs; the first call waits
  return agg && Date.now() - agg.at < 4 * AGG_TTL_MS ? agg : aggInflight;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function horizonsOf(cellsByBand, bands) {
  const out = {};
  for (const b of bands) {
    for (const [h, labels] of Object.entries(cellsByBand[b] || {})) {
      const t = (out[h] ||= {});
      for (const [label, n] of Object.entries(labels)) t[label] = (t[label] || 0) + n;
    }
  }
  return Object.keys(out).map(Number).sort((a, b) => a - b).map((h) => {
    const counts = out[h];
    const decided = OUTCOMES.reduce((s, k) => s + (counts[k] || 0), 0);
    const share = Object.fromEntries(OUTCOMES.map((k) => [k, decided ? r4((counts[k] || 0) / decided) : null]));
    return {
      horizon_days: h, n_decided: decided, share,
      counts: Object.fromEntries(OUTCOMES.map((k) => [k, counts[k] || 0])),
      excluded: { unknown: counts.unknown || 0, unresolvable: counts.unresolvable || 0 },
    };
  });
}

function cohortRule(reasons) {
  const has = (re) => reasons.some((r) => re.test(String(r.r || '')));
  const parts = [];
  if (has(/^liquidity>=/)) parts.push(`liquidity of ${reasons.find((r) => /^liquidity>=/.test(r.r)).r.split('>=')[1]} USD or more`);
  if (has(/^volume>=/)) parts.push(`24h volume of ${reasons.find((r) => /^volume>=/.test(r.r)).r.split('>=')[1]} USD or more`);
  return `Only pools that crossed the ledger's traction threshold are followed: ${parts.join(' or ')} at discovery${has(/^late:/) ? ', or within the 48 hours after it' : ''}. Every other launch is discovered but never followed, so these shares describe launches that got traction, not all launches.`;
}

async function byLaunchpad(launchpad, t0) {
  const a = await getAgg();
  if (!a.lastCycle || Date.now() / 1000 - a.lastCycle > STALE_S) throw unavailable(`launch ledger is stale: last cycle ${a.lastCycle ? iso(a.lastCycle) : 'unknown'}. Not charged.`);
  const names = Object.keys(a.dex).filter((d) => d !== 'unknown');
  const want = norm(launchpad);
  const dex = names.find((d) => norm(d) === want);
  if (!dex) {
    const list = names.map((d) => [d, Object.values(a.dex[d].followed).reduce((s, n) => s + n, 0)]).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
    throw bad(`unknown launchpad ${launchpad}. Followed launchpads (pools): ${list.map(([d, n]) => `${d} (${n})`).join(', ')}`);
  }
  const s = a.dex[dex];
  let bands = Object.keys(s.followed).map(Number);
  let band = null;
  if (t0 != null) {
    const i = BANDS.findIndex(([lo, hi]) => t0 >= lo && (hi == null || t0 < hi));
    bands = [i];
    band = { t0_liq_usd: t0, min_usd: BANDS[i][0], max_usd: BANDS[i][1] };
  }
  const followed = bands.reduce((sum, b) => sum + (s.followed[b] || 0), 0);
  return {
    mode: 'launchpad', launchpad: dex, chain: 'solana', t0_liquidity_band: band,
    pools_followed: followed,
    horizons: horizonsOf(s.cells, bands),
    cohort: cohortRule(a.reasons),
    labels: 'lp_removed: liquidity fell 90% or more from its in-window peak and is under $1,000, or the pool is gone. liquidity_collapsed: fell 70% or more, still above that floor. inactive: liquidity intact but 24h volume under $100. active: kept 50% or more of peak liquidity and trades $1,000 or more a day. Shares are of decided pools; unknown (no observation near the horizon) and unresolvable (the source dropped the pool) are excluded and counted.',
    as_of: iso(a.lastCycle), aggregated_at: new Date(a.at).toISOString(),
    source: 'LaunchLedger (our own Solana launch-to-outcome ledger), read-only',
  };
}

const POOL_COLS = `p.id, p.pool_address, p.base_mint, p.quote_mint, p.name, p.symbol, p.dex, p.discovered_ts, p.pool_created_ts, p.t0_ts,
  p.t0_liquidity_usd, p.t0_volume24h_usd, p.t0_price_usd, p.t0_fdv_usd, p.t0_txns24h, p.t0_mint_authority, p.t0_freeze_authority, p.t0_supply,
  p.cohort, p.cohort_reason, p.retired`;

async function mintPools(mint, { timeout } = {}) {
  if (!MINT_RE.test(mint)) throw bad('mint must be a base58 Solana mint address (32 to 44 characters)');
  // mint is base58 by the check above: no quote or SQL syntax can reach the query
  const pools = await query(`SELECT ${POOL_COLS} FROM pools p WHERE p.base_mint = '${mint}' ORDER BY p.cohort DESC, p.t0_liquidity_usd DESC LIMIT 5`, { timeout });
  if (!pools.length) return { pools: [], checks: [], labels: [] };
  const ids = pools.map((p) => Number(p.id)).filter(Number.isInteger).join(',');
  const [checks, labels] = await Promise.all([
    query(`SELECT c.pool_id, c.ts, c.age_hours, c.liquidity_usd, c.volume24h_usd, c.price_usd, c.fdv_usd, c.txns24h, c.ok
           FROM checks c WHERE c.pool_id IN (${ids}) AND c.ts = (SELECT MAX(ts) FROM checks c2 WHERE c2.pool_id = c.pool_id)`, { timeout }),
    query(`SELECT pool_id, horizon_days, label, evidence, labeled_ts FROM labels WHERE pool_id IN (${ids}) ORDER BY horizon_days`, { timeout }),
  ]);
  return { pools, checks, labels };
}

function poolView(p, checks, labels) {
  const c = checks.find((x) => x.pool_id === p.id);
  return {
    pool: p.pool_address, launchpad: p.dex, name: p.name, symbol: p.symbol, quote_mint: p.quote_mint,
    discovered_at: iso(p.discovered_ts), pool_created_at: iso(p.pool_created_ts),
    followed: p.cohort === 1, ...(p.cohort === 1 ? { followed_because: p.cohort_reason } : {}),
    t0: { at: iso(p.t0_ts || p.discovered_ts), liquidity_usd: r2(p.t0_liquidity_usd), volume24h_usd: r2(p.t0_volume24h_usd), price_usd: p.t0_price_usd, fdv_usd: r2(p.t0_fdv_usd), txns24h: p.t0_txns24h, supply: p.t0_supply },
    authorities_at_t0: { mint_authority: p.t0_mint_authority, freeze_authority: p.t0_freeze_authority },
    latest_check: c ? { at: iso(c.ts), age_hours: r2(c.age_hours), liquidity_usd: r2(c.liquidity_usd), volume24h_usd: r2(c.volume24h_usd), price_usd: c.price_usd, fdv_usd: r2(c.fdv_usd), txns24h: c.txns24h, source_resolved: c.ok === 1 } : null,
    labels: labels.filter((l) => l.pool_id === p.id).map((l) => {
      let evidence = null; try { evidence = l.evidence ? JSON.parse(l.evidence) : null; } catch { /* kept null */ }
      return { horizon_days: l.horizon_days, label: l.label, labeled_at: iso(l.labeled_ts), rule: evidence && evidence.rule ? evidence.rule : null, evidence };
    }),
  };
}

async function byMint(mint) {
  const got = await mintPools(mint);
  if (!got.pools.length) throw notTracked(`not_tracked: ${mint} is not in the launch ledger. The ledger records Solana pools discovered since 2026-07-22 on launchpads and DEXes it watches; a mint it never saw has no t0 snapshot or outcome label. Not charged.`);
  return {
    mode: 'mint', mint, chain: 'solana',
    pools: got.pools.map((p) => poolView(p, got.checks, got.labels)),
    note: 'Labels are mechanical readings of liquidity and volume at each horizon, not a judgement of intent. A pool that is not followed was discovered but never crossed the traction threshold, so it has a t0 snapshot and no labels.',
    source: 'LaunchLedger (our own Solana launch-to-outcome ledger), read-only',
  };
}

async function getLaunchOdds(p = {}) {
  const mint = p.mint == null || p.mint === '' ? null : String(p.mint).trim();
  const launchpad = p.launchpad == null || p.launchpad === '' ? null : String(p.launchpad).trim();
  if (mint && launchpad) throw bad('give either launchpad (optionally with t0_liq_usd) or mint, not both');
  if (mint) return byMint(mint);
  if (!launchpad) throw bad('launchpad or mint is required, e.g. ?launchpad=pump-fun&t0_liq_usd=12000 or ?mint=<Solana mint>');
  let t0 = null;
  if (p.t0_liq_usd != null && p.t0_liq_usd !== '') {
    t0 = Number(p.t0_liq_usd);
    if (!Number.isFinite(t0) || t0 < 0) throw bad('t0_liq_usd must be a non-negative number of USD, e.g. 12000');
  }
  return byLaunchpad(launchpad, t0);
}

// token-risk enrichment: the mint's best pool in the ledger, or null. Never throws, never
// slows token-risk by more than the timeout.
async function launchBlock(mint, { timeout = 2500 } = {}) {
  try {
    if (!MINT_RE.test(String(mint || ''))) return null;
    const got = await mintPools(mint, { timeout });
    if (!got.pools.length) return null;
    const v = poolView(got.pools[0], got.checks, got.labels);
    return {
      tracked: true, pools_in_ledger: got.pools.length, launchpad: v.launchpad, pool: v.pool, followed: v.followed,
      t0: v.t0, authorities_at_t0: v.authorities_at_t0, latest_check: v.latest_check,
      labels: v.labels.map(({ horizon_days, label, rule }) => ({ horizon_days, label, rule })),
      detail: `/api/launch-odds?mint=${mint}`,
    };
  } catch {
    return null;
  }
}

module.exports = { getLaunchOdds, launchBlock, _BANDS: BANDS, _horizonsOf: horizonsOf, _cohortRule: cohortRule };
