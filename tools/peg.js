// tools/peg.js — tokenized-equity peg intelligence from our own collector.
//
// Sources. Every 5 minutes the on-chain DEX price of tokenized US equities on
// Solana is compared with the underlying's last real trade from a US
// market-data feed. Since R5 (12 Oct 2026) the token side is read from chain
// state by our own cron collector (tools/pegonchain.js, peg-onchain.db); before
// its first row the tape is the pegwatch collector's (read-only), whose token
// side came from DexScreener. Window statistics join the two at that cutover;
// the latest token price and liquidity are only ever ours.
//
// HONEST SCOPE — read this before wording anything customer-facing:
//   * Outside US market hours there is no live underlying quote. The reference
//     is the last trade before the close. Off-hours figures therefore measure
//     divergence from that last print, which is the only real price available
//     while the market is shut. They are NOT "depeg vs the live market".
//   * The `open` session is the only one with a continuously live reference,
//     which is why it doubles as the control: deviations there are small.
//   * Dead pools are excluded. A pool where nothing trades reports the same
//     last price forever, which looks like a perfect peg. See FRESH_MIN_PCT.
'use strict';

const fs = require('node:fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.PEGWATCH_DB || '/opt/pegwatch/pegwatch.db';
const OC = require('./pegonchain');

// A symbol needs >2% distinct on-chain prices over the window to count as
// live. Real but illiquid names sit around 11-15%; a dead pool sits at 0.1%.
const FRESH_MIN_PCT = 2;
const FRESH_MIN_TICKS = 100;

let _db = null;
function db() {
  if (_db) return _db;
  if (!fs.existsSync(DB_PATH)) throw new Error('peg database unavailable');
  _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

// caller-input failures carry kind:'bad_request' so server.js logs them apart
// from real service failures; an unmarked throw ('peg database unavailable')
// stays status 'error'
const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });

const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const nowSec = () => Math.floor(Date.now() / 1000);

function pctl(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

// the tape for one symbol since `since`: pegwatch rows before our cutover, ours from it
function tape(symbol, since, cols) {
  const cut = OC.cutover();
  const old = db().prepare(`SELECT ${cols} FROM ticks WHERE symbol = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`).all(symbol, since, cut == null ? Number.MAX_SAFE_INTEGER : cut);
  return cut == null ? old : old.concat(OC.rows(symbol, Math.max(since, cut), cols));
}

function freshness(symbol, since) {
  const rows = tape(symbol, since, 'onchain');
  return { n: rows.length, uniq: new Set(rows.map((r) => r.onchain)).size };
}

const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });

function isDead(f) {
  return !!(f && f.n >= FRESH_MIN_TICKS && (100 * f.uniq / f.n) < FRESH_MIN_PCT);
}

function knownSymbols() {
  return db().prepare(`SELECT DISTINCT symbol FROM ticks ORDER BY symbol`).all().map((r) => r.symbol);
}

function resolveSymbol(input) {
  if (!input) {
    throw badRequest('missing required parameter: symbol — a tokenized equity symbol, e.g. symbol=CRCLx (get_peg_universe lists all tracked symbols)');
  }
  const want = String(input).trim().toUpperCase();
  const all = knownSymbols();
  const hit = all.find((s) => s.toUpperCase() === want)
           || all.find((s) => s.toUpperCase() === want + 'X')
           || all.find((s) => s.toUpperCase().replace(/X$/, '') === want.replace(/X$/, ''));
  if (!hit) throw badRequest(`unknown symbol '${input}'. Available: ${all.join(', ')}`);
  return hit;
}

function statsOf(devs) {
  if (!devs.length) return null;
  const abs = devs.map(Math.abs).sort((a, b) => a - b);
  const mean = abs.reduce((s, v) => s + v, 0) / abs.length;
  return {
    n: abs.length,
    mean_abs_bps: r1(mean),
    p50_abs_bps: r1(pctl(abs, 0.5)),
    p95_abs_bps: r1(pctl(abs, 0.95)),
    max_abs_bps: r1(abs[abs.length - 1]),
    pct_over_100bps: r1(100 * abs.filter((v) => v > 100).length / abs.length),
    pct_over_200bps: r1(100 * abs.filter((v) => v > 200).length / abs.length),
  };
}

const REFERENCE_NOTE =
  'Deviation is measured against the underlying\'s last real trade. Outside US market ' +
  'hours that is the last print before the close, not a live quote. Token prices are read ' +
  'on-chain by our collector since 2026-10-12; earlier samples come from the pegwatch collector.';

// ---- get_peg_deviation -----------------------------------------------------
function getPegDeviation(args = {}) {
  const symbol = resolveSymbol(args.symbol);
  const hours = Math.min(168, Math.max(1, Number(args.hours) || 24));
  const since = nowSec() - hours * 3600;

  const f = freshness(symbol, since);
  if (isDead(f)) {
    return { symbol, status: 'stale_pool', reason:
      `on-chain price unchanged across ${f.n} samples — dead or delisted pool, not a peg`,
      window_hours: hours };
  }

  const rows = tape(symbol, since, 'dev_bps, session, ts');
  if (!rows.length) return { symbol, status: 'no_data', window_hours: hours };

  // the latest token price is only ever our own chain read; none fresh is an outage, not billed
  const latest = OC.latest(symbol);
  if (!latest || latest.dev_bps == null) throw unavailable(`no fresh on-chain peg sample for ${symbol} (our collector writes every 5 minutes). Not charged.`);

  const offhours = rows.filter((r) => r.session !== 'open').map((r) => r.dev_bps);
  const open = rows.filter((r) => r.session === 'open').map((r) => r.dev_bps);

  return {
    symbol,
    status: 'ok',
    window_hours: hours,
    latest: {
      ts: latest.ts,
      iso: new Date(latest.ts * 1000).toISOString(),
      session: latest.session,
      onchain: r2(latest.onchain),
      reference: r2(latest.ref),
      deviation_bps: r1(latest.dev_bps),
      direction: latest.dev_bps > 0 ? 'premium' : 'discount',
      liquidity_usd: Math.round(latest.liq_usd),
      dex: latest.dex,
      pool: latest.pool,
      onchain_source: 'pool price and both vaults read from Solana chain state by our collector',
    },
    window: statsOf(rows.map((r) => r.dev_bps)),
    offhours: statsOf(offhours),
    market_open: statsOf(open),
    note: REFERENCE_NOTE,
  };
}

// ---- get_peg_sessions ------------------------------------------------------
function getPegSessions(args = {}) {
  const symbol = resolveSymbol(args.symbol);
  const days = Math.min(30, Math.max(1, Number(args.days) || 7));
  const since = nowSec() - days * 86400;

  const f = freshness(symbol, since);
  if (isDead(f)) {
    return { symbol, status: 'stale_pool', reason:
      `on-chain price unchanged across ${f.n} samples — dead or delisted pool, not a peg`,
      window_days: days };
  }

  const rows = tape(symbol, since, 'session, dev_bps, liq_usd');
  if (!rows.length) return { symbol, status: 'no_data', window_days: days };

  const order = ['open', 'premarket', 'afterhours', 'overnight', 'weekend'];
  const sessions = {};
  for (const ses of order) {
    const sub = rows.filter((r) => r.session === ses);
    if (sub.length) {
      sessions[ses] = statsOf(sub.map((r) => r.dev_bps));
      const liq = sub.map((r) => r.liq_usd).sort((a, b) => a - b);
      sessions[ses].median_liquidity_usd = Math.round(pctl(liq, 0.5));
    }
  }

  const worst = Object.entries(sessions)
    .filter(([k]) => k !== 'open')
    .sort((a, b) => (b[1].p95_abs_bps || 0) - (a[1].p95_abs_bps || 0))[0];

  return {
    symbol,
    status: 'ok',
    window_days: days,
    sessions,
    worst_offhours_session: worst ? worst[0] : null,
    open_vs_offhours_ratio: sessions.open && worst
      ? r1((worst[1].p95_abs_bps || 0) / (sessions.open.p95_abs_bps || 1)) : null,
    note: REFERENCE_NOTE + ' The open session doubles as a control: tight deviations there ' +
      'indicate the off-hours figures are signal rather than measurement noise.',
  };
}

// ---- get_peg_universe ------------------------------------------------------
function getPegUniverse(args = {}) {
  const days = Math.min(30, Math.max(1, Number(args.days) || 7));
  const since = nowSec() - days * 86400;
  const minLiq = Number(args.min_liquidity_usd) || 0;

  const out = [];
  const excluded = [];
  for (const symbol of knownSymbols()) {
    const f = freshness(symbol, since);
    if (isDead(f)) { excluded.push({ symbol, reason: 'stale_pool' }); continue; }

    const rows = tape(symbol, since, 'dev_bps, session, liq_usd');
    if (!rows.length) continue;

    const liq = rows.map((r) => r.liq_usd).sort((a, b) => a - b);
    const medLiq = Math.round(pctl(liq, 0.5));
    if (medLiq < minLiq) continue;

    const off = statsOf(rows.filter((r) => r.session !== 'open').map((r) => r.dev_bps));
    const open = statsOf(rows.filter((r) => r.session === 'open').map((r) => r.dev_bps));
    out.push({
      symbol,
      n: rows.length,
      offhours_p95_bps: off ? off.p95_abs_bps : null,
      offhours_max_bps: off ? off.max_abs_bps : null,
      open_p95_bps: open ? open.p95_abs_bps : null,
      median_liquidity_usd: medLiq,
    });
  }

  out.sort((a, b) => (b.offhours_p95_bps || 0) - (a.offhours_p95_bps || 0));
  return {
    status: 'ok',
    window_days: days,
    symbols: out,
    excluded,
    ranked_by: 'offhours_p95_bps',
    note: REFERENCE_NOTE,
  };
}

module.exports = { getPegDeviation, getPegSessions, getPegUniverse };
