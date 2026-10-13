// tools/derivs.js — expansion: the derivatives suite on Hyperliquid alone (R7, 13 Oct 2026).
// Two centralised exchanges were read beside Hyperliquid until R6/R7. Their API terms forbid reselling the data
// (docs/SOURCES.md has the clauses), as do Binance's, so every route here answers from Hyperliquid's public info
// API and nothing else. Hyperliquid's terms carry no data or
// redistribution restriction (docs/SOURCES.md, clean).
//
// The error contract is tools/hlperp.js's: a symbol Hyperliquid does not list is a 400 naming what works, and
// a failed Hyperliquid read is a 503 with Retry-After. Both cancel the settlement, so neither is ever billed.
// A history that does not exist yet (open interest changes, the spike scan) says so and is never billed either.
'use strict';
const { cached } = require('../lib/cache');
const HLP = require('./hlperp');
const OI = require('../lib/hl-oi');

const SYM_RE = /^[A-Z0-9]{2,20}USDT$/;
function normSym(s) {
  const raw = String(s || 'SOLUSDT').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(raw)) throw Object.assign(new Error(`invalid symbol: ${String(s).slice(0, 40)}`), { kind: 'bad_request' }); // reject, never sanitize — '../etc' must not become ETCUSDT
  const sym = raw.endsWith('USDT') ? raw : raw + 'USDT';
  if (!SYM_RE.test(sym)) throw Object.assign(new Error(`invalid symbol: ${String(s).slice(0, 40)}`), { kind: 'bad_request' });
  return sym;
}

const pct = (now, then) => (then ? Math.round(((now - then) / then) * 10000) / 100 : null);
const n = (v) => (v == null || v === '' ? null : Number(v));
const clampInt = (v, lo, hi, d) => Math.min(Math.max(parseInt(v) || d, lo), hi);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// ---- funding intervals ------------------------------------------------------
// Hyperliquid settles funding every hour, by protocol (measured 2026-09-28: six consecutive settlements at :00).
// A rate is quoted per its interval; the 8h equivalent and the annualised rate are exact for 1h:
//   raw x 8 / interval, and raw x (24 / interval) x 365 x 100.
const HL_INTERVAL_HOURS = 1;
const to8h = (raw, ih) => (raw == null || ih == null ? null : (raw * 8) / ih);
const annualizedPct = (raw, ih) => (raw == null || ih == null ? null : Number((raw * (24 / ih) * 365 * 100).toFixed(2)));
const rateBasis = (raw, ih) => ({ funding_rate_raw: raw, funding_interval_hours: ih });

// ---- open-interest history (our sampler, lib/hl-oi.js) ----------------------
const HOLE_S = 900; // a stored sample older than this behind the moment asked for is a gap in the record, not that moment
const HISTORY_NOTE = 'open interest history is recorded by our own sampler every 5 minutes (Hyperliquid publishes the current value only); a change is null until the record reaches that far back';

/** change in OI (coin units, so a price move is never mistaken for new positions) over `secs`, or null */
function oiChange(db, coin, oiNow, secs, nowS) {
  if (!db || oiNow == null) return null;
  let r;
  try { r = db.prepare('SELECT ts, oi FROM hl_oi WHERE coin = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(coin, nowS - secs); } catch { return null; }
  if (!r || nowS - secs - r.ts > HOLE_S) return null;
  return pct(oiNow, r.oi);
}

// ---- get_funding_extremes ($0.02) — the most crowded trades across every Hyperliquid perp
async function getFundingExtremes(p = {}) {
  const limit = clampInt(p.limit, 1, 25, 10);
  const minTurn = Number(p.min_turnover_usd) || 1_000_000;
  return cached(`fext:${limit}:${minTurn}`, 30_000, async () => {
    let all;
    try { all = await HLP.universe({ minVolumeUsd: 0 }); } catch (e) { throw HLP.sourceDown(e); }
    if (!all.length) throw HLP.sourceDown(new Error('Hyperliquid returned no perps'));
    const rows = all.filter((r) => (r.volume_24h_usd || 0) >= minTurn).sort((a, b) => b.funding_rate_8h - a.funding_rate_8h);
    return {
      source: HLP.SRC, universe_size: rows.length, min_volume_24h_usd: minTurn,
      most_positive: rows.slice(0, limit),         // longs paying most — short-squeeze fuel is spent, long-flush risk
      most_negative: rows.slice(-limit).reverse(), // shorts paying most — crowded shorts, squeeze candidates
    };
  });
}

// ---- get_open_interest ($0.01) — any Hyperliquid perp, OI + deltas
async function getOpenInterest(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`oi:${sym}`, 60_000, () => HLP.only(sym, async (coin, x) => {
    const nowS = Math.floor(Date.now() / 1000);
    const db = OI.reader();
    const c1 = oiChange(db, coin, x.oi_base, 3600, nowS), c24 = oiChange(db, coin, x.oi_base, 86400, nowS);
    return {
      symbol: sym, mark_price: x.mark, oi_base: x.oi_base, oi_usd: x.oi_usd, change_1h_pct: c1, change_24h_pct: c24,
      ...(c1 == null || c24 == null ? { history_note: HISTORY_NOTE } : {}),
    };
  }));
}

// ---- get_oi_spike_scan ($0.02) — abnormal OI jumps across every Hyperliquid perp
// Reads the sampler (bin/hl-oi-collect.js, one row per coin every 5 minutes, 7 days kept). The window is 24 hours:
// until the record covers it the route answers 503 with Retry-After and is never billed (R7 R1c).
const SPIKE_WINDOW_S = 86_400;
const SPIKE_MIN_OI_USD = 3_000_000; // dust markets are ignored
const SPIKE_MIN_MOVE_PCT = 1;       // a 1h change under 1% is noise whatever its z
const warming = (w, what) => Object.assign(new Error(w.stale && w.samples
  ? `${what}: our Hyperliquid open-interest sampler has not written for over ${Math.round(OI.FRESH_S / 60)} minutes. Not charged.`
  : `${what}: our Hyperliquid open-interest record covers ${w.first_ts ? ((Math.floor(Date.now() / 1000) - w.first_ts) / 3600).toFixed(1) : '0'} of the 24 hours it needs; it is warm at ${w.ready_at ? new Date(w.ready_at * 1000).toISOString() : 'an unknown time'}. Not charged.`),
  { status: 503, retryAfter: w.stale && w.samples ? 60 : Math.min((w.ready_in_min || 1) * 60, 3600),
    warming: { warm: false, needs_hours: 24, first_sample_at: w.first_ts ? new Date(w.first_ts * 1000).toISOString() : null, warm_at: w.ready_at ? new Date(w.ready_at * 1000).toISOString() : null, sampler_stale: !!w.stale } });

/** 1h OI changes (fractions) of one coin's series, each ending at a sample and starting at the sample an hour before it */
function hourChanges(rows) {
  const out = [];
  let j = 0;
  for (let i = 0; i < rows.length; i++) {
    const want = rows[i].ts - 3600;
    while (j + 1 < i && rows[j + 1].ts <= want) j++;
    if (rows[j].ts <= want && want - rows[j].ts <= 330 && rows[j].oi > 0) out.push({ end: rows[i].ts, chg: (rows[i].oi - rows[j].oi) / rows[j].oi });
  }
  return out;
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); };

function spikeScan(db, limit, nowS) {
  const w = OI.warm(SPIKE_WINDOW_S, db, nowS);
  if (!w.warm) throw warming(w, 'oi-spike-scan');
  const last = w.last_ts;
  const cur = OI.snapshot(db, last);
  const then = (secs) => { const m = OI.snapshot(db, last - secs); const ts = m.size ? m.values().next().value.ts : null; return ts != null && last - secs - ts <= HOLE_S ? m : null; };
  const s1 = then(3600), s4 = then(4 * 3600), s24 = then(SPIKE_WINDOW_S);
  if (!s1 || !s4 || !s24) throw Object.assign(new Error('oi-spike-scan: our open-interest record has a gap at one of its baselines (sampler outage). Not charged.'), { status: 503, retryAfter: 300 });
  const series = OI.allSeries(db, SPIKE_WINDOW_S, last);
  const rows = [];
  for (const [coin, c] of cur) {
    const usd = c.mark != null ? c.oi * c.mark : null;
    if (usd == null || usd < SPIKE_MIN_OI_USD) continue;
    const a1 = s1.get(coin), a4 = s4.get(coin), a24 = s24.get(coin);
    if (!a1 || !a4 || !a24) continue;
    const c1 = pct(c.oi, a1.oi), c4 = pct(c.oi, a4.oi), c24 = pct(c.oi, a24.oi);
    if (c1 == null || Math.abs(c1) < SPIKE_MIN_MOVE_PCT) continue;
    // the latest 1h change against that coin's own 1h changes over the day before it (windows that ended an hour or more ago)
    const base = hourChanges(series.get(coin) || []).filter((h) => h.end <= last - 3600).map((h) => h.chg);
    const z = base.length >= 24 && sd(base) > 0 ? (c1 / 100 - mean(base)) / sd(base) : null;
    rows.push({
      coin, symbol: `${coin}USDT`, oi_usd: Math.round(usd),
      oi_change_1h_pct: c1, oi_change_4h_pct: c4, oi_change_24h_pct: c24, spike_z: z == null ? null : Number(z.toFixed(2)),
      price_change_1h_pct: pct(c.mark, a1.mark), funding_rate_8h: c.funding == null ? null : c.funding * 8,
    });
  }
  rows.sort((a, b) => (Math.abs(b.spike_z ?? 0) - Math.abs(a.spike_z ?? 0)) || (Math.abs(b.oi_change_1h_pct) - Math.abs(a.oi_change_1h_pct)));
  return {
    source: `${HLP.SRC}, sampled every 5 minutes by our own collector`,
    as_of: new Date(last * 1000).toISOString(), window_hours: 24, samples: w.samples, coins_scanned: cur.size,
    min_oi_usd: SPIKE_MIN_OI_USD, min_1h_change_pct: SPIKE_MIN_MOVE_PCT,
    method: 'oi_change_* are changes in open interest in coin units (a price move is not new positions). spike_z is the latest 1h change measured in standard deviations of that coin\'s own 1h changes over the previous day (null with under 24 observations). Ranked by |spike_z|.',
    spikes: rows.slice(0, limit),
  };
}
async function getOiSpikeScan(p = {}) {
  const limit = clampInt(p.limit, 1, 25, 10);
  return cached(`oispike:${limit}`, 60_000, async () => {
    const db = OI.reader();
    return spikeScan(db, limit, Math.floor(Date.now() / 1000));
  });
}

// ---- get_basis ($0.01) — Hyperliquid's perp against its oracle
// Hyperliquid has no spot book for most perps. Its oracle price is the validators' weighted median of spot venues,
// published on chain, so mark minus oracle is the perp's premium or discount to spot.
async function getBasis(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`basis:${sym}`, 30_000, () => HLP.only(sym, async (coin, x) => {
    if (x.mark == null || !x.oracle) throw new Error(`no mark or oracle price for ${coin}`);
    const b = Number((((x.mark - x.oracle) / x.oracle) * 100).toFixed(4));
    return {
      symbol: sym, mark_price: x.mark, oracle_price: x.oracle, basis_pct: b,
      basis_against: 'Hyperliquid oracle price (validators\' weighted median of spot venues)',
      state: b > 0.05 ? 'contango (perp premium — longs aggressive)' : b < -0.05 ? 'backwardation (perp discount — shorts aggressive)' : 'flat',
      funding_rate_8h: x.funding_1h != null ? x.funding_1h * 8 : null, ...rateBasis(x.funding_1h, HL_INTERVAL_HOURS),
    };
  }));
}

// ---- get_volatility ($0.01) — realized vol from daily candles
const rvAnn = (closes) => {
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const rv = (arr) => { const m = arr.reduce((s, x) => s + x, 0) / arr.length; const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length; return Number((Math.sqrt(v) * Math.sqrt(365) * 100).toFixed(2)); };
  return { d7: rv(rets.slice(-7)), d30: rv(rets) };
};
async function getVolatility(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`vol:${sym}`, 300_000, () => HLP.only(sym, async (coin) => {
    const k = await HLP.candles(coin, '1d', 32);
    const cl = k.map((x) => Number(x.c));
    // a perp listed for under a week has no volatility to report: the caller's symbol, so a 400 and never billed
    if (cl.length < 8) throw Object.assign(new Error(`not enough daily candles for ${sym} (${cl.length}, 8 needed): too recently listed for a realized volatility`), { kind: 'bad_request' });
    const v = rvAnn(cl); const t = k[k.length - 1];
    return { symbol: sym, realized_vol_7d_ann_pct: v.d7, realized_vol_30d_ann_pct: v.d30, today_range_pct: Number((((Number(t.h) - Number(t.l)) / Number(t.c)) * 100).toFixed(2)), basis: 'daily perp candles' };
  }));
}

// ---- get_funding_history ($0.005) — funding trend for a symbol
// Hyperliquid settles hourly, so `limit` settlements cover `limit` hours. avg_rate_8h is 8 x the mean hourly rate.
async function getFundingHistory(p = {}) {
  const sym = normSym(p.symbol);
  const limit = clampInt(p.limit, 1, 200, 30);
  return cached(`fhist:${sym}:${limit}`, 300_000, () => HLP.only(sym, async (coin) => {
    const h = (await HLP.fundingHistory(coin, limit)).slice(-limit).reverse();
    const raw = h.map((x) => Number(x.fundingRate));
    if (!raw.length) throw new Error(`no funding history for ${coin}`);
    const avg = (8 * raw.reduce((s, x) => s + x, 0)) / raw.length;
    return {
      symbol: sym, intervals: h.length, funding_interval_hours: HL_INTERVAL_HOURS,
      avg_rate_8h: Number(avg.toFixed(8)), avg_annualized_pct: Number((avg * 3 * 365 * 100).toFixed(2)),
      positive_share_pct: Math.round((raw.filter((x) => x > 0).length / raw.length) * 100),
      history: h.map((x) => ({ ts: x.time, rate_8h: Number(x.fundingRate) * 8, ...rateBasis(Number(x.fundingRate), HL_INTERVAL_HOURS) })),
    };
  }));
}

// ---- get_top_movers ($0.01) — 24h gainers/losers with a liquidity floor
async function getTopMovers(p = {}) {
  const limit = clampInt(p.limit, 1, 25, 10);
  const minTurn = Number(p.min_turnover_usd) || 1_000_000;
  return cached(`movers:${limit}:${minTurn}`, 30_000, async () => {
    let all;
    try { all = await HLP.universe({ minVolumeUsd: 0 }); } catch (e) { throw HLP.sourceDown(e); }
    if (!all.length) throw HLP.sourceDown(new Error('Hyperliquid returned no perps'));
    const rows = all.filter((r) => r.change_24h_pct != null && (r.volume_24h_usd || 0) >= minTurn).sort((a, b) => b.change_24h_pct - a.change_24h_pct);
    return { source: HLP.SRC, universe_size: rows.length, min_volume_24h_usd: minTurn, gainers: rows.slice(0, limit), losers: rows.slice(-limit).reverse() };
  });
}

module.exports = {
  getFundingExtremes, getOpenInterest, getOiSpikeScan, getBasis, getVolatility, getFundingHistory, getTopMovers,
  _normSym: normSym,
  _to8h: to8h,
  _annualizedPct: annualizedPct,
  _oiChange: oiChange,
  _hourChanges: hourChanges,
  _spikeScan: spikeScan,
  warming,
  HISTORY_NOTE,
};
