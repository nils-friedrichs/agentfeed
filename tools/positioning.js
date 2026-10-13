// Positioning for SOL and BTC perps, on Hyperliquid alone (R7, 13 Oct 2026):
//   open interest   Hyperliquid's current value, with its 1h and 24h change from our own sampler (lib/hl-oi.js)
//   crowding        the top-250 Hyperliquid accounts' net-long share (tools/hlwhales.js)
// A retail long/short account ratio and a second venue's open interest were served here until R6/R7; that venue's
// API terms forbid resale (docs/SOURCES.md) and no clean venue publishes a retail account ratio, so that field is gone.
// A failed read is a 503 with Retry-After and is never billed.
'use strict';
const D = require('./derivs');
const HW = require('./hlwhales');

const PAIRS = { sol: { sym: 'SOLUSDT', coin: 'SOL' }, btc: { sym: 'BTCUSDT', coin: 'BTC' } };

async function onePair({ sym, coin }) {
  const [oi, w] = await Promise.all([D.getOpenInterest({ symbol: sym }), HW.whaleShare(coin)]);
  return {
    open_interest: { base: oi.oi_base, usd: oi.oi_usd, change_1h_pct: oi.change_1h_pct, change_24h_pct: oi.change_24h_pct, mark_price: oi.mark_price },
    whale_positioning: {
      net_long_share_pct: w.net_long_share_pct, long_usd: w.long_usd, short_usd: w.short_usd, long_accounts: w.long_accounts, short_accounts: w.short_accounts,
      covers: `the top ${w.whale_list_size} Hyperliquid accounts by account value (${w.accounts_with_positions} of them hold perp positions); whale crowding, not the whole market's`,
      as_of: w.as_of,
    },
  };
}

async function getPositioning() {
  const [sol, btc] = await Promise.all([onePair(PAIRS.sol), onePair(PAIRS.btc)]);
  return {
    source: 'Hyperliquid info API (open interest, our 5-minute sampler for its changes) and the top-250 Hyperliquid accounts (net-long share)',
    ...(sol.open_interest.change_24h_pct == null || btc.open_interest.change_24h_pct == null ? { history_note: D.HISTORY_NOTE } : {}),
    sol, btc,
  };
}

module.exports = { getPositioning };
