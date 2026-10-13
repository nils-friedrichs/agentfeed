// tools/fundingradar.js — get_funding_radar ($0.02): every Hyperliquid perp's funding next to its own
// 30-day history, the main dex and the HIP-3 dexes (stocks, indices, commodities, FX) in one table.
//
// R7 (13 Oct 2026): Hyperliquid is the only venue. Two centralised exchanges were read beside it until R6 D2 and R7:
// their API terms forbid reselling the data (docs/SOURCES.md), so the cross-venue spread is gone and the radar
// covers every Hyperliquid perp instead of the pairs the venues shared. Their rows still in fundingradar.db
// are not used.
//
// A funding rate on its own says little: 0.01% per 8h is ordinary on BTC and a
// screaming outlier on a coin that has sat at -0.002% for a month. So per perp
// this returns the current rate at its 8h equivalent and where that rate sits
// against the perp's own settled history (a 30-day z-score), sorted by how
// extreme the reading is.
//
// TWO HALVES, ON PURPOSE.
//   collect()          run by cron (bin/funding-radar-collect.js) every 5 min.
//                      The only code here that talks to Hyperliquid. It stores
//                      settled funding history in fundingradar.db and writes a
//                      precomputed snapshot to funding-radar.json.
//   getFundingRadar()  the paid route. Reads the snapshot and nothing else, so a
//                      paid request never waits on, or fails because of, a rate
//                      limit. A snapshot older than STALE_AFTER_S, or in an older
//                      format, answers 503 and is never billed.
//
// Never fabricated. A rate whose interval cannot be read gets no 8h figure and no
// z-score. A perp with fewer than MIN_SAMPLES settlements in the window gets no
// z-score, and every z-score carries the samples and the window it was actually
// computed over -- 30 days is the target, a younger listing returns what it has.
//
// HIP-3 perps ride the same run: tools/tradfi.js collects their history and the
// rows are merged in below, with their dex and asset class.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = () => process.env.FUNDING_RADAR_DB || path.join(ROOT, 'fundingradar.db');
const SNAP_PATH = () => process.env.FUNDING_RADAR_SNAPSHOT || path.join(ROOT, 'funding-radar.json');
const HL = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const SNAPSHOT_VERSION = 2; // 1 = the two-venue radar of R5/R6; a v1 file answers 503 until the collector has rewritten it
// The tracked universe: every Hyperliquid main-dex perp with a funding rate. No open-interest floor: the floor only
// ever bounded the collector's history calls, and a run's call budget already does that (largest first).
const UNIVERSE_MIN_OI_USD = 0;
const Z_FLAG = 2;
const MIN_SAMPLES = 10;
const STALE_AFTER_S = 15 * 60;
const DEFAULT_TOP = 20;
const DEFAULT_MIN_OI_USD = 10_000_000;
const VENUES = ['hyperliquid'];

const num = (v) => (v == null || v === '' ? null : Number(v));
const finite = (v) => (Number.isFinite(v) ? v : null);
const round = (v, d) => (v == null ? null : Number(v.toFixed(d)));

// ---- statistics (pure, unit-tested) -----------------------------------------

/**
 * Settled rows [{ts, rate}] ascending -> 8h-equivalent series. Each row's
 * interval is the spacing to the row before it; the first row has none and is
 * only used as that predecessor. A gap wider than 8.5h is a halt or a listing
 * gap, not an interval, so it falls back to the symbol's current interval.
 * Hyperliquid settles hourly by protocol, so fixedIntervalH = 1 there.
 */
function to8hSeries(rows, { fixedIntervalH = null, fallbackIntervalH = null } = {}) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    let ih = fixedIntervalH;
    if (ih == null) {
      if (i === 0) continue;
      ih = (rows[i].ts - rows[i - 1].ts) / HOUR;
      if (ih > 8.5) ih = fallbackIntervalH;
      else if (ih < 0.9) ih = 1;
    }
    if (ih == null || !Number.isFinite(rows[i].rate)) continue;
    out.push({ ts: rows[i].ts, r8: (rows[i].rate * 8) / ih });
  }
  return out;
}

/** mean, sample std, n and the window actually covered, over series rows inside [since, now]. */
function windowStats(series, since, now) {
  const xs = series.filter((p) => p.ts >= since && p.ts <= now);
  const n = xs.length;
  if (!n) return { samples: 0, mean_8h: null, std_8h: null, window_days: 0 };
  const mean = xs.reduce((s, p) => s + p.r8, 0) / n;
  const std = n > 1 ? Math.sqrt(xs.reduce((s, p) => s + (p.r8 - mean) ** 2, 0) / (n - 1)) : null;
  const oldest = xs.reduce((m, p) => Math.min(m, p.ts), Infinity);
  return { samples: n, mean_8h: mean, std_8h: std, window_days: round((now - oldest) / DAY, 1) };
}

/** z of the current 8h rate against the window, or null with the reason. */
function zScore(current8h, st) {
  if (current8h == null) return { z: null, z_note: 'no current 8h-equivalent rate (interval unknown)' };
  if (st.samples < MIN_SAMPLES) return { z: null, z_note: `only ${st.samples} settled rates in the window; ${MIN_SAMPLES} needed for a z-score` };
  if (!st.std_8h) return { z: null, z_note: 'the settled rate did not vary over the window, so a z-score is undefined' };
  return { z: (current8h - st.mean_8h) / st.std_8h };
}

/** One perp's radar row from its venue reading. Pure. */
function radarRow(symbol, venues, oi) {
  const out = { symbol, oi_usd: oi, venues: {} };
  let maxAbsZ = null, extremeVenue = null;
  const flagged = [];
  for (const v of VENUES) {
    const r = venues[v];
    out.venues[v] = r || null;
    if (!r) continue;
    if (r.z_30d != null) {
      const a = Math.abs(r.z_30d);
      if (maxAbsZ == null || a > maxAbsZ) { maxAbsZ = a; extremeVenue = v; }
      if (a >= Z_FLAG) flagged.push(v);
    }
  }
  out.max_abs_z = round(maxAbsZ, 2);
  out.flag = flagged.length > 0;
  return out;
}

const rate8h = (r) => Math.abs((r.venues && r.venues.hyperliquid && r.venues.hyperliquid.funding_rate_8h) || 0);
/** Most extreme first: largest |z|, then the largest |funding|. Rows with no z go last. */
function byExtremity(a, b) {
  const za = a.max_abs_z, zb = b.max_abs_z;
  if (za == null && zb != null) return 1;
  if (zb == null && za != null) return -1;
  if (za != null && zb != null && zb !== za) return zb - za;
  return rate8h(b) - rate8h(a);
}

// ---- venue access (collector only) -----------------------------------------

// Spacing between calls, well inside Hyperliquid's published limit (info is 1200 weight a minute and
// fundingHistory weighs 20+) and shared with every other reader on this box.
function pacer(gapMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

// A 500-row fundingHistory page weighs about 45 (20 + 1 per 20 items); at 3.5 s
// between calls the collector stays under ~780 of Hyperliquid's 1200 a minute even
// when every call is a full backfill page.
//
// RUN LENGTH. The cron fires every 5 minutes under flock -n, so a run that outlives
// 5 minutes silently swallows the next one. With the crypto radar (30) and the
// HIP-3 markets (32) both at their Hyperliquid budgets, 62 calls x 3.5 s = 217 s;
// `deadline` is the hard backstop on top: past it a client starts no new call, so
// a slow venue can never stretch a run past ~270 s.
function venueClient({ fetchImpl = fetch, budget = { hyperliquid: 30 }, gaps = { hyperliquid: 3500 }, sharedPace = null, deadline = Infinity } = {}) {
  // sharedPace: a second client with its own budget but the SAME pacer, so two
  // budgets never add up to a faster request rate.
  const pace = sharedPace || Object.fromEntries(VENUES.map((v) => [v, pacer(gaps[v])]));
  const used = { hyperliquid: 0 };
  const left = (v) => (Date.now() >= deadline ? 0 : budget[v] - used[v]);
  async function get(v, url, opts) {
    if (left(v) <= 0) { const e = new Error(`${v}: call budget for this run spent`); e.budget = true; throw e; }
    used[v]++;
    await pace[v]();
    const r = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${v} HTTP ${r.status}`);
    return r.json();
  }
  const hl = (body) => get('hyperliquid', HL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { hl, used, left, pace };
}

const coinOf = (sym) => sym.replace(/USDT$/, '');

/** Current funding, interval and OI of every main-dex perp: one bulk call. Keyed COIN + 'USDT' (the key the history store has always used). */
async function readCurrent(c) {
  const hyperliquid = {};
  const [meta, ctxs] = await c.hl({ type: 'metaAndAssetCtxs' });
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const x = ctxs[i];
    if (!x) return;
    hyperliquid[u.name + 'USDT'] = { raw: num(x.funding), ih: 1, next: null, oi: (num(x.openInterest) || 0) * (num(x.markPx) || 0) };
  });
  return { hyperliquid };
}

// ---- history store ---------------------------------------------------------

function openDb() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS funding (venue TEXT NOT NULL, symbol TEXT NOT NULL, ts INTEGER NOT NULL, rate REAL NOT NULL,
      PRIMARY KEY (venue, symbol, ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS series (venue TEXT NOT NULL, symbol TEXT NOT NULL, backfilled INTEGER NOT NULL DEFAULT 0,
      checked_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (venue, symbol)) WITHOUT ROWID;`);
  return db;
}

/** Settled rows newer than `since` for one series, ascending, from Hyperliquid (hourly settlements, 500 a page). */
async function fetchHistory(c, venue, symbol, since) {
  const rows = [];
  let start = since + 1;
  for (let page = 0; page < 4; page++) {
    const d = await c.hl({ type: 'fundingHistory', coin: coinOf(symbol), startTime: start });
    for (const x of d) rows.push({ ts: num(x.time), rate: num(x.fundingRate) });
    if (d.length < 500) break;
    start = num(d[d.length - 1].time) + 1;
  }
  return rows.filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.rate));
}

// ---- collector ---------------------------------------------------------------

/** A HIP-3 market (tools/tradfi.js section row) as a radar row: the same shape, with its dex and asset class. */
function hip3Row(m) {
  const row = radarRow(m.market, {
    hyperliquid: {
      funding_rate_8h: m.funding_rate_8h, funding_rate_raw: m.funding_rate_1h, funding_interval_hours: 1,
      z_30d: m.z_30d, ...(m.z_note ? { z_note: m.z_note } : {}), mean_8h_30d: m.mean_8h_30d ?? null, std_8h_30d: m.std_8h_30d ?? null,
      samples: m.samples, window_days: m.window_days,
    },
  }, m.oi_usd);
  return { ...row, coin: m.market, dex: m.dex, asset_class: m.asset_class, underlying: m.underlying ?? null };
}

/**
 * One collector run: read current funding, take every main-dex perp as the universe, bring as many
 * history series up to date as this run's call budget allows (largest open
 * interest first, updates before backfill), then write the snapshot from
 * whatever history is stored, with the HIP-3 markets merged in. Returns a summary for the cron log.
 */
async function collect({ now = Date.now(), client = null, log = () => {} } = {}) {
  const t0 = Date.now();
  client = client || venueClient({ deadline: t0 + 200_000 });
  const db = openDb();
  const cur = await readCurrent(client);
  const universe = [];
  for (const s of Object.keys(cur.hyperliquid)) {
    const oi = Math.round(cur.hyperliquid[s].oi);
    if (oi >= UNIVERSE_MIN_OI_USD && cur.hyperliquid[s].raw != null) universe.push({ symbol: s, listed: ['hyperliquid'], oi });
  }
  universe.sort((a, b) => b.oi - a.oi);

  const since30 = now - WINDOW_DAYS * DAY;
  const keepFrom = now - (WINDOW_DAYS + 2) * DAY;
  const latest = db.prepare('SELECT MAX(ts) t FROM funding WHERE venue = ? AND symbol = ?');
  const getSeries = db.prepare('SELECT backfilled, checked_at FROM series WHERE venue = ? AND symbol = ?');
  const putSeries = db.prepare('INSERT INTO series (venue, symbol, backfilled, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(venue, symbol) DO UPDATE SET backfilled = MAX(backfilled, excluded.backfilled), checked_at = excluded.checked_at');
  const ins = db.prepare('INSERT OR IGNORE INTO funding (venue, symbol, ts, rate) VALUES (?, ?, ?, ?)');

  // updates (series already backfilled, a settlement due) first, then backfill
  const due = [];
  for (const u of universe) {
    const v = 'hyperliquid';
    const st = getSeries.get(v, u.symbol) || { backfilled: 0, checked_at: 0 };
    const last = latest.get(v, u.symbol).t;
    const ih = cur[v][u.symbol].ih || 1;
    if (!st.backfilled) due.push({ v, s: u.symbol, since: keepFrom, backfill: true, prio: 1 });
    else if (now - (last || 0) > ih * HOUR + 5 * 60_000 && now - st.checked_at > 10 * 60_000) due.push({ v, s: u.symbol, since: last || keepFrom, backfill: false, prio: 0 });
  }
  due.sort((a, b) => a.prio - b.prio);
  let fetched = 0, failed = 0, skipped = 0;
  for (const d of due) {
    if (client.left(d.v) <= 0) { skipped++; continue; }
    try {
      const rows = await fetchHistory(client, d.v, d.s, d.since);
      db.transaction(() => {
        for (const r of rows) ins.run(d.v, d.s, r.ts, r.rate);
        putSeries.run(d.v, d.s, d.backfill ? 1 : 0, now);
      })();
      fetched++;
    } catch (e) {
      if (e.budget) { skipped++; continue; }
      failed++;
      log(`history ${d.v} ${d.s}: ${e.message}`);
    }
  }
  db.prepare("DELETE FROM funding WHERE venue = 'hyperliquid' AND ts < ?").run(keepFrom);

  // snapshot from stored history
  const hist = db.prepare('SELECT ts, rate FROM funding WHERE venue = ? AND symbol = ? AND ts >= ? ORDER BY ts');
  const rows = [];
  let seriesWithHistory = 0, seriesTotal = 0, seriesFull = 0;
  for (const u of universe) {
    const venues = {};
    for (const v of u.listed) {
      seriesTotal++;
      const c = cur[v][u.symbol];
      const current8h = c.ih ? (c.raw * 8) / c.ih : null;
      const stored = hist.all(v, u.symbol, keepFrom);
      const series = to8hSeries(stored, { fixedIntervalH: 1 });
      const st = windowStats(series, since30, now);
      if (st.samples) seriesWithHistory++;
      if (st.window_days >= WINDOW_DAYS - 0.5) seriesFull++;
      const pending = !(getSeries.get(v, u.symbol) || {}).backfilled;
      let { z, z_note } = zScore(current8h, st);
      // "only 0 settled rates" would read as a fact about the perp when it is
      // a fact about our collector: this series has not been fetched yet.
      if (pending && z == null) z_note = 'history for this perp has not been collected yet (new to the radar); it fills within a few hours';
      venues[v] = {
        funding_rate_8h: round(finite(current8h), 8),
        funding_rate_raw: c.raw,
        funding_interval_hours: c.ih,
        z_30d: round(z, 2),
        ...(z_note ? { z_note } : {}),
        mean_8h_30d: round(st.mean_8h, 8),
        std_8h_30d: round(st.std_8h, 8),
        samples: st.samples,
        window_days: st.window_days,
      };
    }
    rows.push({ ...radarRow(u.symbol, venues, u.oi), coin: coinOf(u.symbol), dex: null });
  }
  // Stock, index, commodity and FX perps (HIP-3) ride the same run, budget and
  // snapshot; a failure there never costs the crypto radar its snapshot.
  let tradfi = null, tradfiSummary = null;
  try {
    // its own call budget, the crypto client's pacer: the crypto radar's hourly
    // Hyperliquid updates can no longer starve the HIP-3 markets of calls
    const tradfiClient = venueClient({ budget: { hyperliquid: 32 }, sharedPace: client.pace, deadline: t0 + 235_000 });
    const t = await require('./tradfi').collectTradfi({ client: tradfiClient, db, now, log, fr: module.exports });
    tradfi = t.section; tradfiSummary = t.summary;
  } catch (e) { log(`tradfi: ${e.message}`); }
  const hip3 = tradfi ? [...tradfi.markets.filter((m) => m.venue === 'hyperliquid'), ...(tradfi.untracked || [])].map(hip3Row) : [];
  const all = rows.concat(hip3);
  all.sort(byExtremity);
  const byDex = { main: rows.length };
  for (const r of hip3) byDex[r.dex] = (byDex[r.dex] || 0) + 1;
  const snapshot = {
    version: SNAPSHOT_VERSION,
    as_of: new Date(now).toISOString(),
    as_of_ms: now,
    universe_floor_oi_usd: UNIVERSE_MIN_OI_USD,
    window_target_days: WINDOW_DAYS,
    coverage: { series_total: seriesTotal, series_with_history: seriesWithHistory, series_full_window: seriesFull },
    perps: { total: all.length, by_dex: byDex },
    symbols: all,
    ...(tradfi ? { tradfi } : {}),
  };
  const tmp = SNAP_PATH() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, SNAP_PATH());
  db.close();
  return { universe: universe.length, hip3: hip3.length, due: due.length, fetched, failed, skipped, calls: { ...client.used }, coverage: snapshot.coverage, tradfi: tradfiSummary, ms: Date.now() - t0 };
}

// ---- the paid route ------------------------------------------------------------

let snapCache = { mtimeMs: 0, data: null };
function readSnapshot() {
  const p = SNAP_PATH();
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (st.mtimeMs !== snapCache.mtimeMs) snapCache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  // a file in the old two-venue format is not served: it is "not built yet" until the collector rewrites it
  return snapCache.data && snapCache.data.version === SNAPSHOT_VERSION ? snapCache.data : null;
}
function unavailable(msg) { const e = new Error(msg); e.status = 503; return e; }

function clampInt(v, lo, hi, d) {
  const x = parseInt(v, 10);
  return Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d;
}

function getFundingRadar(p = {}, { now = Date.now() } = {}) {
  const snap = readSnapshot();
  if (!snap) throw unavailable('funding radar cache has not been built yet; the collector writes it every 5 minutes. Not charged.');
  const top = clampInt(p.top ?? p.limit, 1, 100, DEFAULT_TOP);
  const asked = p.min_oi_usd == null || p.min_oi_usd === '' ? DEFAULT_MIN_OI_USD : Number(p.min_oi_usd);
  if (!Number.isFinite(asked) || asked < 0) {
    const e = new Error(`invalid min_oi_usd: ${p.min_oi_usd}`);
    e.kind = 'bad_request';
    throw e;
  }
  const matched = snap.symbols.filter((r) => (r.oi_usd || 0) >= asked);
  const age = Math.max(0, Math.round((now - snap.as_of_ms) / 1000));
  // a snapshot past the staleness bound is not a reading of "now": 503, never billed (R7 R4; it used to be a stale flag inside a 200)
  if (age > STALE_AFTER_S) throw unavailable(`funding radar snapshot is ${age}s old (limit ${STALE_AFTER_S}s); the collector has stopped or is late. Not charged.`);
  return {
    as_of: snap.as_of,
    age_s: age,
    venues: VENUES,
    window_target_days: snap.window_target_days,
    z_flag_abs: Z_FLAG,
    min_oi_usd: asked,
    universe: snap.perps,
    universe_size: snap.symbols.length,
    matched: matched.length,
    returned: Math.min(top, matched.length),
    coverage: snap.coverage,
    symbols: matched.slice(0, top),
    method: 'funding_rate_8h is the perp\'s current rate at its own interval scaled to 8h (Hyperliquid settles hourly). z_30d compares it with that perp\'s settled 8h-equivalent rates over the last 30 days (samples and window_days are what was actually used; under 10 settled rates gives no z-score, with the reason in z_note). Rows are every Hyperliquid perp on the main dex plus the HIP-3 dexes (dex, asset_class), most extreme |z| first; flag is true when |z| is 2 or more. A perp new to the radar has no z-score until its history is collected.',
  };
}

/** One symbol's radar row straight from the snapshot (not limited to the top N), with its as_of and staleness. */
function getRadarRow(symbol, { now = Date.now() } = {}) {
  const snap = readSnapshot();
  if (!snap) return null;
  const row = snap.symbols.find((r) => r.symbol === symbol);
  const age = Math.max(0, Math.round((now - snap.as_of_ms) / 1000));
  return row ? { row, as_of: snap.as_of, age_s: age, stale: age > STALE_AFTER_S } : { row: null, as_of: snap.as_of, age_s: age, stale: age > STALE_AFTER_S };
}

module.exports = {
  collect, getFundingRadar, getRadarRow,
  _to8hSeries: to8hSeries, _windowStats: windowStats, _zScore: zScore, _radarRow: radarRow, _byExtremity: byExtremity, _hip3Row: hip3Row,
  _venueClient: venueClient, _readCurrent: readCurrent, _fetchHistory: fetchHistory,
  STALE_AFTER_S, UNIVERSE_MIN_OI_USD, DEFAULT_MIN_OI_USD, DEFAULT_TOP, SNAPSHOT_VERSION,
};
