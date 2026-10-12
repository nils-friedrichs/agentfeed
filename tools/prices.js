// tools/prices.js — SOL, BTC and ETH spot in USD, from on-chain DEX pools (R5 C1, 12 Oct 2026).
//
// HISTORY. Pyth Hermes until Aug 27 2026 (401 keyless since, and its terms forbid re-serving raw
// prices). Then Coinbase first and Kraken second, with Binance, OKX and Gemini added for the
// eth-price quotes. All five forbid redistributing their market data (docs/SOURCES.md), so the
// planning chat of 12 Oct moved spot to the chains: tools/dexspot.js reads two deep USDC pools per
// asset (Solana for SOL; Ethereum and Base for BTC and ETH) and this module serves their median.
//
// Every pool is read on every miss of the 5 s cache, in parallel. One pool answering is enough;
// none answering is a real outage and throws with status 503, so the caller is never billed.
// Nothing here invents a price, and no expired cache is served.
//
// RETURN SHAPE IS FROZEN for getPrice: { symbol, price, confidence, publish_time, source }.
// confidence is null (a pool has no confidence interval), publish_time is the read time in unix
// seconds, and source names the pools that answered. getPriceQuotes adds quotes[], one per pool.
'use strict';
const DEX = require('./dexspot');

const SYMBOLS = Object.keys(DEX.POOLS); // SOL, BTC, ETH
const DP = { SOL: 4, BTC: 2, ETH: 2 };
const CACHE_MS = 5000;
const cache = new Map(); // symbol -> { at, data }

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const label = (q) => `${q.venue} ${q.pair} on ${q.chain}`;

async function read(symbol) {
  if (!DEX.POOLS[symbol]) throw Object.assign(new Error(`unsupported symbol: ${symbol}`), { kind: 'bad_request' });
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const { quotes, errors } = await DEX.readPools(symbol);
  if (!quotes.length) throw unavailable(`every on-chain pool failed for ${symbol}: ${errors.join('; ')}. Not charged.`);
  if (errors.length) console.log(`[prices] ${symbol}: ${errors.join('; ')}`);
  const data = { at: Date.now(), quotes, price: Number(median(quotes.map((q) => q.price)).toFixed(DP[symbol])) };
  cache.set(symbol, { at: data.at, data });
  return data;
}

async function getPrice(symbol) {
  const d = await read(symbol);
  return {
    symbol,
    price: d.price,
    confidence: null,
    publish_time: Math.floor(d.at / 1000),
    source: `on-chain DEX mid, median of ${d.quotes.map(label).join('; ')}`,
  };
}

async function getPriceQuotes(symbol) {
  const d = await read(symbol);
  return {
    symbol,
    price: d.price,
    quotes: d.quotes.map((q) => ({ source: `${q.venue}:${q.chain}`, pair: q.pair, pool: q.pool, price: Number(q.price.toFixed(DP[symbol] + 2)) })),
    confidence: null,
    publish_time: Math.floor(d.at / 1000),
    source: `on-chain DEX mid, median of ${d.quotes.length} pools`,
    method: 'each pool\'s current price (concentrated-liquidity sqrt price, fee excluded) read from chain state; price is their median',
  };
}

module.exports = { getPrice, getPriceQuotes, SYMBOLS };
