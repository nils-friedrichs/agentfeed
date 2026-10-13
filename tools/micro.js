// tools/micro.js — expansion: microstructure suite (2 tools), on Hyperliquid's l2Book alone.
// Two centralised exchanges' orderbook, trade tape and ticker were read here until R6/R7; their terms forbid
// resale (docs/SOURCES.md). get_whale_trades and get_spread_arb read only those, so they were withdrawn (410).
'use strict';
const { _normSym: normSym } = require('./derivs');
const HLP = require('./hlperp');

// Hyperliquid's l2Book: 20 aggregated levels a side, as [{ px, sz, n }], here as [px, sz] pairs
const hlBook = async (coin) => { const b = await HLP.l2Book(coin); return { b: b.levels[0].map((l) => [l.px, l.sz]), a: b.levels[1].map((l) => [l.px, l.sz]) }; };
const usd = (side, test) => side.reduce((s, [px, sz]) => (test(parseFloat(px)) ? s + parseFloat(px) * parseFloat(sz) : s), 0);

// ---- get_orderbook_imbalance ($0.01) — bid/ask notional within ±bps of mid
async function getOrderbookImbalance(p = {}) {
  const sym = normSym(p.symbol);
  const bps = Math.min(Math.max(Number(p.bps) || 50, 5), 500);
  return HLP.only(sym, async (coin) => {
    const h = await hlBook(coin);
    if (!h.b.length || !h.a.length) throw new Error(`empty book for ${coin}`);
    const m = (parseFloat(h.b[0][0]) + parseFloat(h.a[0][0])) / 2;
    const lo = m * (1 - bps / 10000), hi = m * (1 + bps / 10000);
    const bu = usd(h.b, (px) => px >= lo), au = usd(h.a, (px) => px <= hi);
    const r = au > 0 ? bu / au : null;
    return {
      symbol: sym, mid_price: Number(m.toFixed(6)), window_bps: bps,
      bid_usd: Math.round(bu), ask_usd: Math.round(au),
      imbalance_ratio: r != null ? Number(r.toFixed(3)) : null,
      skew: r == null ? null : r > 1.5 ? 'bid_heavy (support below)' : r < 0.67 ? 'ask_heavy (resistance above)' : 'balanced',
      note: 'visible resting liquidity only — spoofable, read as context not signal',
      depth_note: 'Hyperliquid serves 20 aggregated levels a side, so a wide window may reach past its visible book',
    };
  });
}

// ---- get_orderbook_walls ($0.01) — largest resting levels per side
async function getOrderbookWalls(p = {}) {
  const sym = normSym(p.symbol);
  const top = Math.min(Math.max(parseInt(p.top) || 5, 1), 15);
  return HLP.only(sym, async (coin) => {
    const h = await hlBook(coin);
    if (!h.b.length || !h.a.length) throw new Error(`empty book for ${coin}`);
    const m = (parseFloat(h.b[0][0]) + parseFloat(h.a[0][0])) / 2;
    const walls = (side) => side
      .map(([px, sz]) => ({ price: parseFloat(px), usd: Math.round(parseFloat(px) * parseFloat(sz)) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, top)
      .map((w) => ({ ...w, distance_pct: Number((((w.price - m) / m) * 100).toFixed(3)) }));
    return { symbol: sym, mid_price: Number(m.toFixed(6)), depth_levels: h.b.length + h.a.length, bid_walls: walls(h.b), ask_walls: walls(h.a) };
  });
}

module.exports = { getOrderbookImbalance, getOrderbookWalls };
