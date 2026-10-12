// tools/hip3.js — /api/tradfi-perps (R5 B3): 24/7 stock, index, commodity and FX perps on
// Hyperliquid HIP-3, read from Hyperliquid's public info API only (never a deployer's site or
// API: their terms cover those, the on-chain state is Hyperliquid's; docs/SOURCES.md).
//   perpDexs                    the HIP-3 dexes (index 0 is the native dex, skipped)
//   metaAndAssetCtxs {dex}      per dex: markPx, oraclePx, premium, funding, OI, prevDayPx
// Prices are each market's own HIP-3 oracle and mark, never "the S&P" or an exchange quote.
// Cached 60 s (about 220 of the 1,200 weight/min an IP gets); Hyperliquid failing with no
// fresh cache is a 503.
'use strict';
const path = require('path');
const INFO = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const CACHE_MS = 60 * 1000;
const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const num = (v) => (v == null || v === '' ? null : Number(v));
const r = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
let classes = null;
function classOf(market) {
  if (!classes) { try { classes = require(path.join(__dirname, '..', 'data', 'tradfi-classes.json')).markets || {}; } catch { classes = {}; } }
  const c = classes[market];
  return c ? { asset_class: c.asset_class || 'unclassified', underlying: c.underlying || null } : { asset_class: 'unclassified', underlying: null };
}

async function info(body) {
  const res = await fetch(INFO(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`hyperliquid info HTTP ${res.status}`);
  return res.json();
}

let cache = null; let inflight = null;
async function snapshot() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  if (!inflight) inflight = (async () => {
    const dexes = (await info({ type: 'perpDexs' })).filter(Boolean);
    const markets = [];
    for (const d of dexes) {
      let mc; try { mc = await info({ type: 'metaAndAssetCtxs', dex: d.name }); } catch { continue; }
      const [meta, ctxs] = mc;
      (meta.universe || []).forEach((u, i) => {
        const c = ctxs[i] || {}; const mark = num(c.markPx); const oracle = num(c.oraclePx); const prev = num(c.prevDayPx);
        if (u.isDelisted || !mark) return;
        markets.push({ market: u.name, dex: d.name, dex_name: d.fullName || null, ticker: u.name.split(':').pop(), ...classOf(u.name),
          mark_px: mark, oracle_px: oracle, premium_pct: r(num(c.premium) * 100, 4), funding_1h: num(c.funding),
          funding_8h_pct: r(num(c.funding) * 8 * 100, 5), open_interest_usd: r((num(c.openInterest) || 0) * mark, 0),
          change_24h_pct: prev ? r((mark - prev) / prev * 100, 3) : null, volume_24h_usd: r(num(c.dayNtlVlm), 0), max_leverage: u.maxLeverage || null });
      });
    }
    if (!markets.length) throw new Error('no HIP-3 markets returned');
    cache = { at: Date.now(), dexes: dexes.map((d) => ({ dex: d.name, name: d.fullName || null, deployer: d.deployer || null })), markets };
    return cache;
  })().finally(() => { inflight = null; });
  try { return await inflight; } catch (e) {
    // a failed refresh may serve the last snapshot for 2 min (as_of says how old); older is stale: 503
    if (cache && Date.now() - cache.at < 2 * CACHE_MS) return cache;
    throw unavailable(`Hyperliquid HIP-3 data unavailable (${String(e.message).slice(0, 100)}). Not charged.`);
  }
}

async function getTradfiPerps(p = {}) {
  const raw = p.symbol == null || p.symbol === '' ? null : String(p.symbol).trim();
  if (raw && !/^([a-z0-9]{1,8}:)?[A-Za-z0-9._\-]{1,20}$/.test(raw)) throw bad('symbol must be a HIP-3 ticker such as TSLA, GOLD or EUR, or a dex-qualified market such as xyz:TSLA');
  const s = await snapshot();
  const base = { as_of: new Date(s.at).toISOString(), source: 'Hyperliquid info API (perpDexs, metaAndAssetCtxs), HIP-3 dexes', prices_are: 'each market\'s own HIP-3 oracle and mark price, not an exchange quote', dexes: s.dexes };
  if (raw) {
    const want = raw.includes(':') ? raw.toLowerCase() : raw.toUpperCase();
    const rows = s.markets.filter((m) => (raw.includes(':') ? m.market.toLowerCase() === want : m.ticker.toUpperCase() === want));
    if (!rows.length) throw bad(`no live HIP-3 market for ${raw}; call without symbol for the list`);
    return { ...base, symbol: raw, count: rows.length, markets: rows.sort((a, b) => b.open_interest_usd - a.open_interest_usd) };
  }
  const rows = [...s.markets].sort((a, b) => b.open_interest_usd - a.open_interest_usd)
    .map(({ market, dex, ticker, asset_class, mark_px, oracle_px, change_24h_pct, funding_8h_pct, open_interest_usd }) => ({ market, dex, ticker, asset_class, mark_px, oracle_px, change_24h_pct, funding_8h_pct, open_interest_usd }));
  const by = {}; for (const m of rows) by[m.asset_class] = (by[m.asset_class] || 0) + 1;
  return { ...base, count: rows.length, by_asset_class: by, markets: rows };
}

module.exports = { getTradfiPerps, _snapshot: snapshot };
