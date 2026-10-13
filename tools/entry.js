// tools/entry.js — the entry tier ($0.001 until 2026-10-08, now $0.005): four compact routes composed from
// functions this service already runs. Nothing here adds an upstream source.
//
// WHY THESE FOUR. Measured on the Bazaar 2026-09-25: the six best-selling
// routes in this niche are all $0.001, and the single most-bought route in the
// whole niche is a universal real-time primitive (hugen.tokyo's FX bid/ask,
// 169 distinct payers). AgentFeed had no cheap universal entry point at all --
// its floor was a $0.001 single-asset price and everything else was premium.
//
// Each answer is cached per symbol so a popular route cannot multiply upstream
// calls: one cache entry serves every concurrent caller (lib/cache.js collapses
// identical in-flight requests into one).
//
// NEVER FAKES, NEVER BILLS A NON-ANSWER. A route whose source failed or is stale answers 503 with
// Retry-After (R7 R4): the settlement is cancelled, so nothing is charged, and it never returns zeros
// dressed as data. A decline inside a 200 is kept only where the decline is itself the product (squeeze).
//
// R6 D1 (13 Oct 2026): ONE EXCEPTION, THE CALLER'S SYMBOL. A symbol the route does
// not serve (price: not SOL, BTC or ETH; perp: listed nowhere and never in our tape)
// is a caller error, not an answer: HTTP 400 with {error, supported:[...]}, thrown before
// anything settles, so it is never billed. A symbol we DO serve where the data cannot
// answer still declines with 200, because that decline is the product.
'use strict';
const Database = require('better-sqlite3');
const { cached } = require('../lib/cache');
const { CORE } = require('../universe');
const { _normSym: normSym, getOpenInterest, getFundingExtremes } = require('./derivs');
const HLP = require('./hlperp');
const { getFundingRate } = require('./funding');
const { getPrice, SYMBOLS } = require('./prices');

const DB_PATH = process.env.LIQ_DB || '/opt/agentfeed/liquidations.db';
let db = null;
function tape() {
  // READ-ONLY. liqcollector owns this file and writes it continuously.
  if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}

const TTL = 45_000; // inside the 30-60s the brief asks for
const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const n2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

/** Newest row in the tape, and how old it is. The freshness gate for anything
 *  that reports "right now" from our own recording. */
function tapeAge() {
  const row = tape().prepare('SELECT MAX(ts) AS newest FROM liquidations').get();
  const newest = row && row.newest ? Number(row.newest) : null;
  return { newest, age_sec: newest ? Math.round((Date.now() - newest) / 1000) : null };
}
const STALE_SEC = 30 * 60; // the brief's bound: older than 30 minutes is stale

/** 24h liquidation slice for ONE symbol, straight from our tape. */
function liq24h(sym) {
  const since = Date.now() - 86_400_000;
  const r = tape().prepare(`
    SELECT COUNT(*) AS prints,
           COALESCE(SUM(usd),0) AS total_usd,
           COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0) AS longs_usd,
           COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0) AS shorts_usd,
           COALESCE(MAX(usd),0) AS biggest_print_usd,
           COUNT(DISTINCT exchange) AS venues
    FROM liquidations WHERE symbol = ? AND ts >= ?`).get(sym, since);
  return {
    prints: r.prints,
    total_usd: n2(r.total_usd),
    longs_usd: n2(r.longs_usd),
    shorts_usd: n2(r.shorts_usd),
    biggest_print_usd: n2(r.biggest_print_usd),
    venues: r.venues,
    dominant_side: r.longs_usd >= r.shorts_usd ? 'longs' : 'shorts',
  };
}

// ---- a. GET /api/perp?symbol= -------------------------------------------
// Hyperliquid funding and open interest plus our own tape's 24h liquidations. Hyperliquid is the one venue read
// (the centralised venues forbid resale, docs/SOURCES.md): asked and down is a 503; a symbol it does not list but our tape has
// recorded is answered from the tape alone, with funding and open interest null and the reason named.
async function getPerp(p = {}) {
  const sym = normSym(p.symbol || 'SOLUSDT');
  return cached(`entry:perp:${sym}`, TTL, async () => {
    let listed = true;
    try { await HLP.resolve(sym); } catch (e) {
      if (e.status === 503) throw e; // the only venue could not be asked: ours to fail, never billed
      listed = false;
    }
    const age = tapeAge();
    const liq = liq24h(sym);
    if (!listed) {
      // listed nowhere: a symbol our tape has never recorded either is the caller's mistake (400, unbilled)
      const seen = tape().prepare('SELECT 1 AS hit FROM liquidations WHERE symbol = ? LIMIT 1').get(sym);
      if (!seen) throw Object.assign(new Error(`unsupported symbol "${sym}": Hyperliquid lists no perp for it and it has never appeared in our liquidation tape. Any Hyperliquid perp works, e.g. ${CORE.join(', ')}.`), { kind: 'bad_request' });
    }
    let funding = null, openInterest = null;
    const missing = [];
    if (listed) {
      const [f, oi] = await Promise.all([getFundingRate({ symbol: sym }), getOpenInterest({ symbol: sym })]);
      const h = f.venues.hyperliquid;
      funding = { venues: f.venues, crowding: h.funding_rate_raw > 0 ? 'longs_pay' : h.funding_rate_raw < 0 ? 'shorts_pay' : 'flat' };
      openInterest = { hyperliquid: { oi_base: oi.oi_base, oi_usd: oi.oi_usd, change_1h_pct: oi.change_1h_pct, change_24h_pct: oi.change_24h_pct }, mark_price: oi.mark_price };
    } else {
      missing.push(`funding (Hyperliquid lists no perp for ${sym})`, `open_interest (Hyperliquid lists no perp for ${sym})`);
    }
    return {
      symbol: sym,
      funding,
      open_interest: openInterest,
      liquidations_24h: liq,
      tape_age_sec: age.age_sec,
      partial: missing.length ? missing : null,
      source: 'hyperliquid funding and open interest, liquidations from our own tape',
    };
  });
}

// ---- b. GET /api/liq-pulse ----------------------------------------------
async function getLiqPulse() {
  return cached('entry:liqpulse', TTL, async () => {
    const age = tapeAge();
    // Prove the tape is live BEFORE answering. A collector that died would
    // otherwise make a quiet hour and a dead feed look identical.
    if (age.newest == null || age.age_sec > STALE_SEC) {
      throw Object.assign(new Error(age.newest == null
        ? 'the liquidation tape is empty; totals withheld rather than reported as zero. Not charged.'
        : `the liquidation tape is ${age.age_sec}s old, past the ${STALE_SEC}s freshness bound; totals withheld rather than reported as zero. Not charged.`), { status: 503 });
    }
    const since = Date.now() - 3_600_000;
    const t = tape().prepare(`
      SELECT COUNT(*) AS prints, COALESCE(SUM(usd),0) AS total_usd,
             COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0) AS longs_usd,
             COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0) AS shorts_usd,
             COUNT(DISTINCT symbol) AS symbols, COUNT(DISTINCT exchange) AS venues
      FROM liquidations WHERE ts >= ?`).get(since);
    const top = tape().prepare(`
      SELECT symbol, COUNT(*) AS prints, ROUND(SUM(usd),2) AS usd,
             ROUND(COALESCE(SUM(CASE WHEN side='Buy'  THEN usd END),0),2) AS longs_usd,
             ROUND(COALESCE(SUM(CASE WHEN side='Sell' THEN usd END),0),2) AS shorts_usd
      FROM liquidations WHERE ts >= ? GROUP BY symbol ORDER BY SUM(usd) DESC LIMIT 5`).all(since);
    return {
      stale: false,
      window_min: 60,
      tape_age_sec: age.age_sec,
      prints: t.prints,
      total_usd: n2(t.total_usd),
      longs_usd: n2(t.longs_usd),
      shorts_usd: n2(t.shorts_usd),
      dominant_side: t.longs_usd >= t.shorts_usd ? 'longs' : 'shorts',
      symbols: t.symbols,
      venues: t.venues,
      top_symbols: top.map((r) => ({ ...r, dominant_side: r.longs_usd >= r.shorts_usd ? 'longs' : 'shorts' })),
      source: 'our own liquidation tape (Bybit, OKX and Binance streams)',
    };
  });
}

// ---- c. GET /api/funding-pulse ------------------------------------------
async function getFundingPulse() {
  return cached('entry:fundingpulse', TTL, async () => {
    // Every Hyperliquid perp above the liquidity floor, the one venue this service screens (R7). An empty or failed
    // screen is a 503: the route is not billed for a table we could not build.
    const x = await getFundingExtremes({ limit: 5 });
    const rows = [...(x.most_positive || []), ...(x.most_negative || [])]
      .map((r) => ({ coin: r.coin, venue: 'hyperliquid', funding_rate_8h: r.funding_rate_8h, funding_rate_raw: r.funding_rate_raw, funding_interval_hours: 1, annualized_pct: r.annualized_pct, oi_usd: r.oi_usd, price_24h_pct: r.change_24h_pct }))
      .sort((a, b) => Math.abs(b.annualized_pct) - Math.abs(a.annualized_pct))
      .slice(0, 5);
    if (!rows.length) throw HLP.sourceDown(new Error(`the funding screener returned no rows for the Hyperliquid perps above $${x.min_volume_24h_usd} of 24h volume`));
    return {
      extremes: rows,
      universe_size: x.universe_size,
      min_volume_24h_usd: x.min_volume_24h_usd,
      venue_scope: ['hyperliquid'],
      note: 'Ranked by absolute annualised funding across every Hyperliquid perp above the liquidity floor. For the whole table with each coin\'s 30-day z-score use /api/funding-radar.',
      source: x.source,
    };
  });
}

// ---- d. GET /api/price?symbol= ------------------------------------------
// The price module reads on-chain pools per symbol (tools/dexspot.js), so its
// coverage is exactly the symbols it has pools for. SUPPORTED is read from the
// module's own table at require time, so adding pools there extends this route.
const SUPPORTED = SYMBOLS;
async function getSpot(p = {}) {
  const raw = String(p.symbol || 'SOL').trim().toUpperCase();
  const sym = raw.replace(/USDT?$/, '') || raw;
  if (!SUPPORTED.includes(sym)) {
    // R6 D1: the caller's symbol, so 400 before any settlement (never billed), with the list it can use
    throw Object.assign(new Error(`unsupported symbol "${raw.slice(0, 40)}": /api/price serves ${SUPPORTED.join(', ')} from on-chain pools. For any USDT perp mark price use /api/perp.`), { kind: 'bad_request', supported: [...SUPPORTED] });
  }
  return cached(`entry:spot:${sym}`, TTL, async () => {
    const q = await getPrice(sym);
    return { symbol: q.symbol, price: q.price, confidence: q.confidence, publish_time: q.publish_time, source: q.source, supported: SUPPORTED };
  });
}

module.exports = { getPerp, getLiqPulse, getFundingPulse, getSpot, _SUPPORTED: SUPPORTED, _tapeAge: tapeAge };
