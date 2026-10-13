// tools/funding.js — perp funding from Hyperliquid public info API.
// Swapped from Binance (their ToS prohibits charging for their market data).
// Hyperliquid: decentralized perp DEX, public API, no account/ToS gate.
const { _normSym: normSym, _to8h: to8h, _annualizedPct: annualizedPct } = require('./derivs');
const HLP = require('./hlperp');
const API = 'https://api.hyperliquid.xyz/info';
const SYMBOLS = ['SOL', 'BTC'];

let cached = null; // { at, byName }
const CACHE_MS = 60_000;

async function refresh() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.byName;
  let meta, ctxs;
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
    [meta, ctxs] = await res.json();
  } catch (e) { throw HLP.sourceDown(e); } // a failed read is a 503 with Retry-After, never billed (R7 R4)
  const byName = {};
  meta.universe.forEach((u, i) => {
    if (ctxs[i]) byName[u.name] = ctxs[i]; // every perp: getHlCtx serves the others
  });
  cached = { at: Date.now(), byName };
  return byName;
}

async function getFunding(symbol) {
  if (!SYMBOLS.includes(symbol)) throw new Error(`unsupported symbol: ${symbol}`);
  const byName = await refresh();
  const c = byName[symbol];
  if (!c) throw new Error(`hyperliquid: no ctx for ${symbol}`);
  const hourly = Number(c.funding);
  return {
    symbol,
    funding_rate_hourly: hourly,
    funding_rate_8h_equiv: Number((hourly * 8).toFixed(8)),
    funding_rate_pct_hourly: Number((hourly * 100).toFixed(6)),
    mark_price: Number(Number(c.markPx).toFixed(symbol === 'BTC' ? 2 : 4)),
    open_interest: Number(c.openInterest),
    source: 'hyperliquid',
  };
}

// ---- GET /api/funding-rate[?symbol=] -----------------------------------------
// Without a symbol: the SOL and BTC Hyperliquid answer this route has always
// given, byte for byte. With one: that USDT perp's funding on Hyperliquid, the one venue
// left since R7 (the centralised exchanges forbid resale, docs/SOURCES.md), under `venues.hyperliquid` as before.
// A symbol Hyperliquid does not list is a 400 and a failed read a 503: neither is billed.
async function getFundingRate(p = {}) {
  if (p.symbol == null || p.symbol === '') return { sol: await getFunding('SOL'), btc: await getFunding('BTC') };
  let sym;
  try { sym = normSym(p.symbol); } catch (e) { e.kind = 'bad_request'; throw e; }
  const h = await HLP.only(sym, async (coin, c) => ({ funding_rate_raw: c.funding_1h, mark_price: c.mark }));
  // Hyperliquid settles every hour on the hour (measured 2026-09-28: six
  // consecutive settlements at :00 on SOL and ONDO), so its next one is the next
  // top of the hour, taken when answering rather than out of the 60 s cache.
  const nextHour = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000;
  const raw = h.funding_rate_raw, ih = 1;
  return {
    symbol: sym,
    venues: {
      hyperliquid: {
        funding_rate_raw: raw,
        funding_interval_hours: ih,
        funding_rate_8h: to8h(raw, ih),
        annualized_pct: annualizedPct(raw, ih),
        next_funding_time: nextHour,
        mark_price: h.mark_price,
      },
    },
    note: 'The rate is quoted for its own interval: funding_rate_8h = raw x 8 / funding_interval_hours, annualized_pct = raw x 24 / funding_interval_hours x 365 x 100. Hyperliquid settles hourly.',
    source: 'hyperliquid public funding',
  };
}

// one Hyperliquid perp's raw context (oraclePx, markPx, funding, openInterest, prevDayPx), 60 s cache
async function getHlCtx(coin) {
  const c = (await refresh())[coin];
  if (!c) throw Object.assign(new Error(`hyperliquid: no perp context for ${coin}`), { status: 503 });
  return c;
}

module.exports = { getFunding, getFundingRate, getHlCtx };
