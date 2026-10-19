// lib/related.js — the `related` array on the three free routes (R15b, 19 Oct 2026).
//
// /api/fear-greed (1,536 calls from 34 addresses in 14 days), /api/last-liquidation (181) and /api/exit-method (171) are the free routes
// that get used. Each answer now carries `related`: at most two items naming the closest paid route, as plain data:
//   { tool, path, price_usd, adds }
// `tool`, `path` and `price_usd` are read from the price table (a price change cannot leave a stale number here); `adds` is a noun phrase
// saying what that route returns beyond the free answer. No imperative wording and no address to the reader: the CDP index screens
// published text for instructions (task #108), and test/related.test.js holds this file to it.
'use strict';

const SPEC = {
  get_fear_greed: [
    { route: 'GET /api/market-snapshot', adds: 'SOL and BTC spot prices read on-chain, both Hyperliquid perp funding rates with mark price and open interest, and this index, in one call' },
    { route: 'GET /api/market-state', adds: 'for BTC, ETH, SOL or HYPE: basis, realized volatility, funding with its 30-day z-score, open interest changes, liquidations by side for 1h and 24h, and the next FOMC or CPI release' },
  ],
  get_last_liquidation: [
    { route: 'GET /api/liquidations', adds: 'the same prints without the 15-minute delay, for any USDT perp, with a minimum-size filter' },
    { route: 'GET /api/liq-feed', adds: "5-second buckets of long and short USD liquidated across venues, with the dominant side and the pressure against the symbol's own baseline" },
  ],
  get_exit_method: [
    { route: 'GET /api/exit-quote', adds: 'the largest clip of a Kamino reserve a liquidator can sell with positive margin, from live routing against the oracle mark' },
  ],
};

const pathOf = (route) => route.replace(/^GET /, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** The related array of one free tool; an item whose route is not in the price table is left out rather than published stale. */
function relatedFor(tool, PRICES) {
  return (SPEC[tool] || []).filter((x) => PRICES[x.route]).slice(0, 2)
    .map((x) => ({ tool: PRICES[x.route].tool, path: pathOf(x.route), price_usd: PRICES[x.route].usd, adds: x.adds }));
}

module.exports = { relatedFor, SPEC, pathOf };
