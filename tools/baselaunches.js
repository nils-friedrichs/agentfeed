// tools/baselaunches.js — /api/base-launches: new Base pools from the last 24 hours (R3, 2026-10-12).
//
// Served from base-launches.json, which bin/base-launches-collect.js writes every minute
// from on-chain logs (pool creations, swaps, V4 positions) and pool reads; a paid request
// never calls a node. A snapshot older than 5 minutes answers 503 and is never charged.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SNAP_PATH = () => process.env.BASE_LAUNCHES_SNAPSHOT || path.join(__dirname, '..', 'base-launches.json');
const STALE_MS = 5 * 60 * 1000;

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });

let cached = null; // { mtimeMs, snap }
function readSnapshot() {
  let st;
  try { st = fs.statSync(SNAP_PATH()); } catch { throw unavailable('Base launch snapshot not written yet. Not charged.'); }
  if (!cached || cached.mtimeMs !== st.mtimeMs) {
    try { cached = { mtimeMs: st.mtimeMs, snap: JSON.parse(fs.readFileSync(SNAP_PATH(), 'utf8')) }; } catch { throw unavailable('Base launch snapshot unreadable. Not charged.'); }
  }
  return cached.snap;
}

function num(v, name, lo, hi, d) {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${name} must be a number from ${lo} to ${hi}`);
  return n;
}

function getBaseLaunches(p = {}, { now = Date.now() } = {}) {
  const minLiq = num(p.min_liq_usd, 'min_liq_usd', 0, 1e12, 1000);
  const limit = Math.floor(num(p.limit, 'limit', 1, 100, 20));
  const snap = readSnapshot();
  const age = now - Date.parse(snap.as_of);
  if (!(age <= STALE_MS)) throw unavailable(`Base launch snapshot is ${Math.round(age / 60000)} minutes old, limit 5. Not charged.`);
  const rows = snap.launches.filter((l) => (minLiq === 0 ? true : (l.quote_liquidity_usd || 0) >= minLiq));
  return {
    as_of: snap.as_of, head_block: snap.head_block, window_hours: snap.window_hours,
    filters: { min_liq_usd: minLiq, limit },
    matched: rows.length,
    launches: rows.slice(0, limit),
    counts_24h: snap.counts,
    eth_usd: snap.eth_usd,
    coverage: {
      venues: 'Uniswap V4 (PoolManager Initialize), Uniswap V3 and V2, Aerodrome v2 and Slipstream factory pool creations on Base',
      indexed_since: snap.indexed_since, volume_counted_since: snap.volume_counted_since,
      last_gap: snap.last_gap || null,
      shadow_pools: 'Bot pools that pair a new token with a fake mmETH token are left out and counted.',
    },
    method: 'From Base logs and pool reads, refreshed every minute. quote_liquidity_usd is the ETH, WETH or USDC the pool holds (for V4, priced from its own positions at the current price), so it is what sellers can take out at most; pools quoted in other tokens show null. volume_24h is the quote side of every swap since volume_counted_from. launchpad comes from the V4 hook or the creating factory, each address from the launchpad\'s own docs; otherwise the raw hook address is shown. honeypot is our own buy-then-sell simulation of the busiest pools, as in /api/honeypot-check; null means not simulated yet.',
    sources: ['Base chain logs via base.gateway.tenderly.co', 'pool reads via mainnet.base.org', 'our honeypot simulator'],
  };
}

module.exports = { getBaseLaunches };
