#!/usr/bin/env node
// bin/base-launches-collect.js — the Base launch collector behind /api/base-launches (R3, 2026-10-12).
//
// Runs from root crontab every minute, under flock and a hard deadline, like the
// funding-radar collector:
//   * * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/base-launches.lock /usr/bin/timeout 58 /usr/bin/node --max-old-space-size=192 bin/base-launches-collect.js >> /opt/agentfeed/base-launches.log 2>&1
//
// ON-CHAIN ONLY. Pool creations come from logs: Uniswap V4 PoolManager Initialize, Uniswap
// V3 and V2 factory PoolCreated/PairCreated, Aerodrome v2 and Slipstream factory
// PoolCreated (base.drpc.org, whose free tier answers getLogs up to about 100 blocks;
// Tenderly's gateway was dropped in R4: its terms allow use only for our own benefit). Volume is summed
// from the same pools' Swap logs on the quote side (ETH, WETH or USDC); liquidity is read
// from the pool (quote-side balance, or V4 in-range virtual reserves). GeckoTerminal was in
// the brief; CoinGecko's API terms forbid storing or redistributing its data, so it is not
// called. Launchpads are named from V4 hook addresses and factory addresses in
// data/base-v4-hooks.json, each with its official source; anything else stays the raw address.
//
// Writes baselaunches.db (our own index; tools/honeypot.js reads its V4 pool keys) and the
// snapshot base-launches.json that the paid route serves. A paid request never calls a node.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const V = require('viem');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.BASE_LAUNCHES_DB || path.join(ROOT, 'baselaunches.db');
const SNAP_PATH = process.env.BASE_LAUNCHES_SNAPSHOT || path.join(ROOT, 'base-launches.json');
const LABELS_PATH = path.join(ROOT, 'data', 'base-v4-hooks.json');
const LOG_RPC = process.env.BASE_LOG_RPC || 'https://base.drpc.org';
const READ_RPC = process.env.BASE_SIM_RPC || 'https://mainnet.base.org';
const DEADLINE = Date.now() + Number(process.env.COLLECT_DEADLINE_MS || 50000);
const MAX_SPAN = Number(process.env.LOG_SPAN || 100); // dRPC free: ranges over ~100 blocks are refused
const MAX_CATCHUP = 2400;         // 80 minutes; further behind than this: jump to head, record the gap
const WINDOW_S = 24 * 3600;      // launches listed: the last 24h
const KEEP_POOLS_S = 30 * 86400; // V4 pool keys kept for the honeypot check
const SIMS_PER_RUN = Number(process.env.SIMS_PER_RUN || 6);
const SIM_TTL_S = 30 * 60;

const A = {
  poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  v3Factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
  v2Factory: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  aeroFactory: '0x420dd381b31aef6683db6b902084cb0ffece40da',
  aeroCL: '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a',
  multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
  ethUsdPool: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
  weth: '0x4200000000000000000000000000000000000006',
  usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const ZERO = '0x0000000000000000000000000000000000000000';
const T = {
  v4Init: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  v4Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  v4Modify: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  v3Created: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  aeroCreated: '0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e',
  clCreated: '0xab0d57f0df537bb25e80245ef7748fa62353808c54d6e528a9dd20887aed9ac2',
  v2Created: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  v3Swap: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  v2Swap: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  aeroSwap: '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b',
};
const QUOTES = { [ZERO]: { symbol: 'ETH', dec: 18 }, [A.weth]: { symbol: 'WETH', dec: 18 }, [A.usdc]: { symbol: 'USDC', dec: 6 } };

const log = (...a) => console.log(new Date().toISOString(), '[base-launches]', ...a);
const left = () => DEADLINE - Date.now();

// The log RPC rate-limits bursts: calls to it are spaced (LOG_GAP_MS) and a "rate limit"
// answer is retried with backoff before the run gives up.
let LOG_GAP_MS = Number(process.env.LOG_GAP_MS || 1000);
let lastLogCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    if (left() < 1500) throw new Error('deadline');
    if (url === LOG_RPC) { const wait = lastLogCall + LOG_GAP_MS - Date.now(); if (wait > 0) await sleep(wait); lastLogCall = Date.now(); }
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(Math.min(15000, left())) });
    const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    if (!j.error) return j.result;
    if (/rate limit|429|too many|timeout|upgrade to paid/i.test(String(j.error.message)) && attempt < 3 && left() > 6000) { await sleep(1500 * 2 ** attempt); continue; }
    throw new Error(`${method}: ${j.error.message}`);
  }
}
const hex = (n) => '0x' + n.toString(16);
const word = (data, i) => '0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const addrW = (w) => ('0x' + w.slice(-40)).toLowerCase();
const s256 = (w) => BigInt.asIntN(256, BigInt(w));
const s24 = (w) => Number(BigInt.asIntN(24, BigInt(w)));

const MC = V.parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[])',
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
]);
async function multicall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 150) {
    const chunk = calls.slice(i, i + 150);
    const data = V.encodeFunctionData({ abi: MC, functionName: 'aggregate3', args: [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: V.encodeFunctionData({ abi: MC, functionName: c.fn, args: c.args || [] }) }))] });
    const res = await rpc(READ_RPC, 'eth_call', [{ to: A.multicall, data }, 'latest']);
    const dec = V.decodeFunctionResult({ abi: MC, functionName: 'aggregate3', data: res });
    dec.forEach((o, j) => {
      if (!o.success || o.returnData === '0x') return out.push(null);
      try { out.push(V.decodeFunctionResult({ abi: MC, functionName: chunk[j].fn, data: o.returnData })); } catch { out.push(null); }
    });
  }
  return out;
}

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pools (pool_id TEXT PRIMARY KEY, kind TEXT NOT NULL, token0 TEXT NOT NULL, token1 TEXT NOT NULL,
      fee INTEGER, tick_spacing INTEGER, hooks TEXT, stable INTEGER, created_block INTEGER NOT NULL, created_ts INTEGER NOT NULL,
      tx_hash TEXT, tx_to TEXT, launchpad TEXT, init_sqrt_price TEXT);
    CREATE INDEX IF NOT EXISTS idx_pools_t0 ON pools(token0);
    CREATE INDEX IF NOT EXISTS idx_pools_t1 ON pools(token1);
    CREATE INDEX IF NOT EXISTS idx_pools_ts ON pools(created_ts);
    CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, name TEXT, symbol TEXT, decimals INTEGER, fetched_ts INTEGER);
    CREATE TABLE IF NOT EXISTS vol (pool_id TEXT NOT NULL, minute INTEGER NOT NULL, quote_amt REAL NOT NULL, swaps INTEGER NOT NULL, PRIMARY KEY (pool_id, minute)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS pos (pool_id TEXT NOT NULL, tl INTEGER NOT NULL, tu INTEGER NOT NULL, liq REAL NOT NULL, PRIMARY KEY (pool_id, tl, tu)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS liq (pool_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, liquidity_usd REAL, basis TEXT);
    CREATE TABLE IF NOT EXISTS sims (pool_id TEXT PRIMARY KEY, token TEXT, ts INTEGER NOT NULL, verdict TEXT, buy_tax REAL, sell_tax REAL, transfer_ok INTEGER, revert TEXT, venue TEXT);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}
const getMeta = (db, k) => { const r = db.prepare('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; };
const setMeta = (db, k, v) => db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));

function loadLabels() {
  try {
    const j = JSON.parse(fs.readFileSync(LABELS_PATH, 'utf8'));
    const hooks = {}; const txTo = {};
    for (const e of j.hooks || []) hooks[e.address.toLowerCase()] = e.launchpad;
    for (const e of j.tx_to || []) txTo[e.address.toLowerCase()] = e.launchpad;
    const sh = j.shadow || {};
    return { hooks, txTo, shadowTokens: new Set((sh.tokens || []).map((a) => a.toLowerCase())), shadowTo: new Set((sh.tx_to || []).map((a) => a.toLowerCase())) };
  } catch { return { hooks: {}, txTo: {}, shadowTokens: new Set(), shadowTo: new Set() }; }
}

function parseCreate(l) {
  const t0 = l.topics[0];
  const base = { created_block: parseInt(l.blockNumber, 16), tx_hash: l.transactionHash };
  if (t0 === T.v4Init) {
    return { ...base, pool_id: l.topics[1].toLowerCase(), kind: 'uniswap-v4', token0: addrW(l.topics[2]), token1: addrW(l.topics[3]),
      fee: Number(BigInt(word(l.data, 0))), tick_spacing: s24(word(l.data, 1)), hooks: addrW(word(l.data, 2)), init_sqrt_price: BigInt(word(l.data, 3)).toString() };
  }
  if (t0 === T.v3Created) return { ...base, pool_id: addrW(word(l.data, 1)), kind: 'uniswap-v3', token0: addrW(l.topics[1]), token1: addrW(l.topics[2]), fee: Number(BigInt(l.topics[3])), tick_spacing: s24(word(l.data, 0)) };
  if (t0 === T.aeroCreated) return { ...base, pool_id: addrW(word(l.data, 0)), kind: 'aerodrome-v2', token0: addrW(l.topics[1]), token1: addrW(l.topics[2]), stable: Number(BigInt(l.topics[3])) };
  if (t0 === T.clCreated) return { ...base, pool_id: addrW(word(l.data, 0)), kind: 'aerodrome-cl', token0: addrW(l.topics[1]), token1: addrW(l.topics[2]), tick_spacing: s24(l.topics[3]) };
  if (t0 === T.v2Created) return { ...base, pool_id: addrW(word(l.data, 0)), kind: 'uniswap-v2', token0: addrW(l.topics[1]), token1: addrW(l.topics[2]) };
  return null;
}
const quoteOf = (p) => (QUOTES[p.token1] ? p.token1 : QUOTES[p.token0] ? p.token0 : null);

// One chunk of activity for pools we hold: V4 Swap and ModifyLiquidity on the PoolManager
// (one call), Swap logs of V2/V3/Aerodrome pool addresses. Volume is the quote side of
// each swap; V4 positions are summed per (pool, tick range) to price the quote side later.
async function activity(db, from, to, tsOf, pools) {
  const addVol = db.prepare(`INSERT INTO vol (pool_id, minute, quote_amt, swaps) VALUES (?, ?, ?, 1) ON CONFLICT(pool_id, minute) DO UPDATE SET quote_amt = quote_amt + excluded.quote_amt, swaps = swaps + 1`);
  const addPos = db.prepare(`INSERT INTO pos (pool_id, tl, tu, liq) VALUES (?, ?, ?, ?) ON CONFLICT(pool_id, tl, tu) DO UPDATE SET liq = liq + excluded.liq`);
  const evm = [...pools.values()].filter((p) => p.kind !== 'uniswap-v4').map((p) => p.pool_id);
  const v4logs = await rpc(LOG_RPC, 'eth_getLogs', [{ address: A.poolManager, topics: [[T.v4Swap, T.v4Modify]], fromBlock: hex(from), toBlock: hex(to) }]);
  const plogs = [];
  for (let i = 0; i < evm.length; i += 400) {
    plogs.push(...await rpc(LOG_RPC, 'eth_getLogs', [{ address: evm.slice(i, i + 400), topics: [[T.v3Swap, T.v2Swap, T.aeroSwap]], fromBlock: hex(from), toBlock: hex(to) }]));
  }
  let swaps = 0;
  db.transaction(() => {
    for (const l of v4logs) {
      const p = pools.get(l.topics[1].toLowerCase());
      if (!p) continue;
      if (l.topics[0] === T.v4Modify) {
        addPos.run(p.pool_id, s24(word(l.data, 0)), s24(word(l.data, 1)), Number(s256(word(l.data, 2))));
        continue;
      }
      const q = quoteOf(p); if (!q) continue;
      const amt = s256(word(l.data, q === p.token0 ? 0 : 1));
      addVol.run(p.pool_id, Math.floor(tsOf(parseInt(l.blockNumber, 16)) / 60) * 60, Math.abs(Number(amt)) / 10 ** QUOTES[q].dec); swaps++;
    }
    for (const l of plogs) {
      const p = pools.get(l.address.toLowerCase());
      if (!p) continue;
      const q = quoteOf(p); if (!q) continue;
      const is0 = q === p.token0;
      let amt;
      if (l.topics[0] === T.v3Swap) amt = Math.abs(Number(s256(word(l.data, is0 ? 0 : 1))));
      else { const inn = Number(BigInt(word(l.data, is0 ? 0 : 1))); const out = Number(BigInt(word(l.data, is0 ? 2 : 3))); amt = inn + out; }
      addVol.run(p.pool_id, Math.floor(tsOf(parseInt(l.blockNumber, 16)) / 60) * 60, amt / 10 ** QUOTES[q].dec); swaps++;
    }
  })();
  return swaps;
}

// Quote asset held by a V4 pool's positions at the current price (raw units), from the
// ModifyLiquidity ranges we summed: for each range [a, b] with liquidity L and current
// sqrt price s, token1 = L * (clamp(s) - sa), token0 = L * (1/clamp(s) - 1/sb).
function v4QuoteAmount(rows, sqrtPriceX96, quoteIs1) {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  let amt = 0;
  for (const r of rows) {
    if (!(r.liq > 0)) continue;
    const sa = Math.pow(1.0001, r.tl / 2); const sb = Math.pow(1.0001, r.tu / 2);
    const c = Math.min(Math.max(s, sa), sb);
    amt += quoteIs1 ? r.liq * (c - sa) : r.liq * (1 / c - 1 / sb);
  }
  return amt;
}

async function main() {
  const t0 = Date.now();
  const db = openDb();
  const labels = loadLabels();
  const head = await rpc(LOG_RPC, 'eth_getBlockByNumber', ['latest', false]);
  const headN = parseInt(head.number, 16);
  const headTs = parseInt(head.timestamp, 16);
  const tsOf = (b) => headTs - (headN - b) * 2; // Base: one block every 2 seconds
  let from = Number(getMeta(db, 'last_block') || headN - 30) + 1;
  if (headN - from > MAX_CATCHUP) { log(`behind by ${headN - from} blocks: jumping to head, gap recorded`); setMeta(db, 'last_gap', JSON.stringify({ from, to: headN - 30, at: headTs })); from = headN - 30; }
  if (!getMeta(db, 'first_block_ts')) setMeta(db, 'first_block_ts', tsOf(from));
  if (!getMeta(db, 'volume_from_ts')) { setMeta(db, 'volume_from_ts', tsOf(from)); setMeta(db, 'volume_from_block', from); }

  const ins = db.prepare(`INSERT OR IGNORE INTO pools (pool_id, kind, token0, token1, fee, tick_spacing, hooks, stable, created_block, created_ts, tx_hash, launchpad, init_sqrt_price)
    VALUES (@pool_id, @kind, @token0, @token1, @fee, @tick_spacing, @hooks, @stable, @created_block, @created_ts, @tx_hash, @launchpad, @init_sqrt_price)`);
  const recent = () => db.prepare(`SELECT pool_id, kind, token0, token1 FROM pools WHERE created_ts >= ?`).all(headTs - 2 * WINDOW_S);

  let created = 0; let swaps = 0;
  while (from <= headN && left() > 15000) {
    const to = Math.min(from + MAX_SPAN - 1, headN);
    // a rate limit while catching up ends this run's log reads, not the run: progress is kept
    // per chunk and the snapshot is still written, so the route stays fresh while it catches up
    try {
    const logs = await rpc(LOG_RPC, 'eth_getLogs', [{ address: [A.poolManager, A.v3Factory, A.aeroFactory, A.aeroCL, A.v2Factory], topics: [[T.v4Init, T.v3Created, T.aeroCreated, T.clCreated, T.v2Created]], fromBlock: hex(from), toBlock: hex(to) }]);
    const rows = logs.map(parseCreate).filter(Boolean).map((p) => ({ fee: null, tick_spacing: null, hooks: null, stable: null, init_sqrt_price: null, ...p, created_ts: tsOf(p.created_block), launchpad: p.hooks && labels.hooks[p.hooks] ? labels.hooks[p.hooks] : null }));
    db.transaction(() => { for (const r of rows) created += ins.run(r).changes; })();

    swaps += await activity(db, from, to, tsOf, new Map(recent().map((p) => [p.pool_id, p])));
    } catch (e) {
      // any upstream failure ends this run's log reads; the snapshot below is still written,
      // stamped with the last block actually processed, so a stall ages into a 503
      log(`log reads stopped at block ${from}: ${e.message}`); break;
    }
    setMeta(db, 'last_block', to);
    from = to + 1;
  }

  // a hook added to data/base-v4-hooks.json labels the pools already held
  const relabel = db.prepare("UPDATE pools SET launchpad = ? WHERE kind = 'uniswap-v4' AND hooks = ? AND launchpad IS NULL AND created_ts >= ?");
  db.transaction(() => { for (const [h, pad] of Object.entries(labels.hooks)) relabel.run(pad, h, headTs - 2 * WINDOW_S); })();

  // label V4 pools without a hook label by the transaction's `to` (launchpad factories), at most 40 per run
  const unlabeled = db.prepare(`SELECT pool_id, tx_hash FROM pools WHERE kind='uniswap-v4' AND launchpad IS NULL AND tx_to IS NULL AND created_ts >= ? ORDER BY created_ts DESC LIMIT 40`).all(headTs - WINDOW_S);
  const setTo = db.prepare('UPDATE pools SET tx_to=?, launchpad=COALESCE(launchpad, ?) WHERE pool_id=?');
  for (const u of unlabeled) {
    if (left() < 12000) break;
    try { const tx = await rpc(READ_RPC, 'eth_getTransactionByHash', [u.tx_hash]); const to = String(tx && tx.to || '').toLowerCase(); setTo.run(to || '-', labels.txTo[to] || null, u.pool_id); } catch { break; }
  }

  // token metadata for new tokens
  const need = db.prepare(`SELECT DISTINCT t FROM (SELECT token0 AS t FROM pools WHERE created_ts >= ? UNION SELECT token1 FROM pools WHERE created_ts >= ?) WHERE t NOT IN (SELECT address FROM tokens) AND t != ? LIMIT 200`).all(headTs - WINDOW_S, headTs - WINDOW_S, ZERO).map((r) => r.t);
  if (need.length && left() > 10000) {
    const res = await multicall(need.flatMap((t) => [{ target: t, fn: 'name' }, { target: t, fn: 'symbol' }, { target: t, fn: 'decimals' }]));
    const up = db.prepare('INSERT OR REPLACE INTO tokens (address, name, symbol, decimals, fetched_ts) VALUES (?,?,?,?,?)');
    db.transaction(() => need.forEach((t, i) => up.run(t, res[3 * i] ? String(res[3 * i]).slice(0, 64) : null, res[3 * i + 1] ? String(res[3 * i + 1]).slice(0, 32) : null, res[3 * i + 2] == null ? null : Number(res[3 * i + 2]), headTs)))();
  }

  // ETH/USD from the WETH/USDC pool, then liquidity of the last 24h's launches
  let usdPerEth = Number(getMeta(db, 'eth_usd') || 0) || null;
  if (left() > 8000) {
    const [s] = await multicall([{ target: A.ethUsdPool, fn: 'slot0' }]);
    if (s) { const sp = Number(s[0]) / 2 ** 96; usdPerEth = sp * sp * 1e12; setMeta(db, 'eth_usd', usdPerEth); setMeta(db, 'eth_usd_ts', headTs); }
  }
  const usdOf = (q, amt) => (q === A.usdc ? amt : usdPerEth ? amt * usdPerEth : null);
  const volFrom = Number(getMeta(db, 'volume_from_ts') || headTs);
  const isShadow = (p) => labels.shadowTokens.has(p.token0) || labels.shadowTokens.has(p.token1) || (p.tx_to && labels.shadowTo.has(p.tx_to));
  const all24 = db.prepare(`SELECT p.*, COALESCE((SELECT SUM(quote_amt) FROM vol v WHERE v.pool_id=p.pool_id AND v.minute >= ?), 0) AS vq FROM pools p WHERE p.created_ts >= ?`).all(headTs - WINDOW_S, headTs - WINDOW_S);
  const win = all24.filter((p) => !isShadow(p));
  const shadowCount = all24.length - win.length;
  // refreshed per run: the 300 busiest, everything created in the last 15 minutes, and the
  // 400 least recently read, so every listed launch is read within ~20 minutes
  const liqTs = new Map(db.prepare('SELECT pool_id, ts FROM liq').all().map((r) => [r.pool_id, r.ts]));
  const priced = win.filter((p) => quoteOf(p));
  const pick = new Map();
  for (const p of [...priced].sort((a, b) => b.vq - a.vq).slice(0, 300)) pick.set(p.pool_id, p);
  for (const p of priced) if (p.created_ts >= headTs - 900) pick.set(p.pool_id, p);
  for (const p of [...priced].filter((x) => !pick.has(x.pool_id)).sort((a, b) => (liqTs.get(a.pool_id) || 0) - (liqTs.get(b.pool_id) || 0)).slice(0, 400)) pick.set(p.pool_id, p);
  const liqTargets = [...pick.values()];
  if (liqTargets.length && left() > 8000) {
    const calls = []; const map = [];
    for (const p of liqTargets) {
      const q = quoteOf(p);
      if (p.kind === 'uniswap-v4') { calls.push({ target: A.stateView, fn: 'getSlot0', args: [p.pool_id] }); map.push([p, q, 2]); }
      else if (q !== ZERO) { calls.push({ target: q, fn: 'balanceOf', args: [p.pool_id] }); map.push([p, q, 1]); }
    }
    const res = await multicall(calls);
    const up = db.prepare('INSERT OR REPLACE INTO liq (pool_id, ts, liquidity_usd, basis) VALUES (?,?,?,?)');
    const posOf = db.prepare('SELECT tl, tu, liq FROM pos WHERE pool_id=?');
    let k = 0;
    db.transaction(() => {
      for (const [p, q, n] of map) {
        const dec = QUOTES[q].dec;
        if (n === 2) {
          const s0 = res[k]; k += 1;
          if (!s0 || s0[0] === 0n) continue;
          // positions are complete only for pools created after activity tracking began
          if (p.created_ts < volFrom) { up.run(p.pool_id, headTs, null, 'v4_positions_incomplete'); continue; }
          const amt = v4QuoteAmount(posOf.all(p.pool_id), s0[0], q === p.token1) / 10 ** dec;
          const usd = usdOf(q, amt);
          up.run(p.pool_id, headTs, usd == null ? null : Math.round(usd * 100) / 100, 'v4_positions_quote_side');
        } else {
          const b = res[k]; k += 1;
          if (b == null) continue;
          const usd = usdOf(q, Number(b) / 10 ** dec);
          up.run(p.pool_id, headTs, usd == null ? null : Math.round(usd * 100) / 100, 'pool_quote_balance');
        }
      }
    })();
  }

  // honeypot simulation of the top launches by volume, within a small per-run budget
  let simmed = 0;
  if (SIMS_PER_RUN > 0 && left() > 10000) {
    const H = require('../tools/honeypot');
    const due = db.prepare(`SELECT p.pool_id, p.token0, p.token1, p.kind FROM pools p LEFT JOIN sims s ON s.pool_id = p.pool_id
      WHERE p.created_ts >= ? AND (s.ts IS NULL OR s.ts < ?) ORDER BY COALESCE((SELECT SUM(quote_amt) FROM vol v WHERE v.pool_id=p.pool_id), 0) DESC LIMIT ?`).all(headTs - WINDOW_S, headTs - SIM_TTL_S, SIMS_PER_RUN * 3);
    const put = db.prepare('INSERT OR REPLACE INTO sims (pool_id, token, ts, verdict, buy_tax, sell_tax, transfer_ok, revert, venue) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const d of due) {
      if (simmed >= SIMS_PER_RUN || left() < 9000) break;
      const q = quoteOf(d); if (!q || labels.shadowTokens.has(d.token0) || labels.shadowTokens.has(d.token1)) continue;
      const token = q === d.token0 ? d.token1 : d.token0;
      try {
        const r = await H.getHoneypotCheck({ token: V.getAddress(token) });
        const revert = r.simulation && ((r.simulation.sell && r.simulation.sell.revert) || (r.simulation.buy && r.simulation.buy.revert)) || null;
        put.run(d.pool_id, token, headTs, r.verdict, r.buy_tax_pct, r.sell_tax_pct, r.transfer_ok == null ? null : r.transfer_ok ? 1 : 0, revert, r.simulation ? r.simulation.venue : null);
        simmed++;
      } catch (e) { if (e.status === 503) break; put.run(d.pool_id, token, headTs, 'error', null, null, null, String(e.message).slice(0, 120), null); }
    }
  }

  // snapshot
  const tok = db.prepare('SELECT name, symbol, decimals FROM tokens WHERE address=?');
  const liqOf = db.prepare('SELECT liquidity_usd, basis, ts FROM liq WHERE pool_id=?');
  const simOf = db.prepare('SELECT verdict, buy_tax, sell_tax, transfer_ok, revert, venue, ts FROM sims WHERE pool_id=?');
  const swapsOf = db.prepare('SELECT COALESCE(SUM(swaps),0) AS n FROM vol WHERE pool_id=? AND minute >= ?');
  const launches = win.map((p) => {
    const q = quoteOf(p);
    const token = q ? (q === p.token0 ? p.token1 : p.token0) : p.token0;
    const t = tok.get(token) || {}; const l = liqOf.get(p.pool_id); const s = simOf.get(p.pool_id);
    return {
      pool: p.pool_id, venue: p.kind, created_at: new Date(p.created_ts * 1000).toISOString(), created_block: p.created_block,
      token, name: t.name || null, symbol: t.symbol || null,
      quote: q ? QUOTES[q].symbol : null, pair: `${t.symbol || token.slice(0, 8)}/${q ? QUOTES[q].symbol : (tok.get(p.token1) || {}).symbol || p.token1.slice(0, 8)}`,
      ...(p.kind === 'uniswap-v4' ? { hook: p.hooks, launchpad: p.launchpad || (p.hooks === ZERO ? 'none (no hook)' : null), launchpad_tx_to: p.tx_to && p.tx_to !== '-' ? p.tx_to : null, fee: p.fee, tick_spacing: p.tick_spacing } : { launchpad: p.launchpad || null, ...(p.fee != null ? { fee: p.fee } : {}), ...(p.stable != null ? { stable: !!p.stable } : {}) }),
      quote_liquidity_usd: l ? l.liquidity_usd : null, liquidity_basis: l ? l.basis : null, liquidity_at: l ? new Date(l.ts * 1000).toISOString() : null,
      volume_24h_quote: q ? Math.round(p.vq * 1e6) / 1e6 : null, volume_24h_usd: q ? (usdOf(q, p.vq) == null ? null : Math.round(usdOf(q, p.vq) * 100) / 100) : null,
      swaps_24h: swapsOf.get(p.pool_id, headTs - WINDOW_S).n,
      volume_counted_from: new Date(Math.max(p.created_ts, volFrom, headTs - WINDOW_S) * 1000).toISOString(),
      honeypot: s ? { verdict: s.verdict, buy_tax_pct: s.buy_tax, sell_tax_pct: s.sell_tax, transfer_ok: s.transfer_ok == null ? null : !!s.transfer_ok, revert: s.revert, simulated_on: s.venue, at: new Date(s.ts * 1000).toISOString() } : null,
    };
  }).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const byPad = {};

  for (const l of launches) { const k = l.launchpad || (l.venue === 'uniswap-v4' ? `hook ${l.hook}` : l.venue); byPad[k] = (byPad[k] || 0) + 1; }
  const processed = Number(getMeta(db, 'last_block') || headN);
  const snap = {
    as_of: new Date(tsOf(processed) * 1000).toISOString(), head_block: processed, chain_head_block: headN, window_hours: 24, eth_usd: usdPerEth,
    indexed_since: new Date(Number(getMeta(db, 'first_block_ts')) * 1000).toISOString(),
    volume_counted_since: new Date(volFrom * 1000).toISOString(),
    last_gap: getMeta(db, 'last_gap') ? JSON.parse(getMeta(db, 'last_gap')) : null,
    counts: { launches: launches.length, shadow_pools_left_out: shadowCount, by_launchpad: Object.entries(byPad).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([launchpad, n]) => ({ launchpad, n })) },
    // newest 1000, plus older ones that show liquidity or volume of $1k or more: keeps the file small
    launches: [...launches.slice(0, 1000), ...launches.slice(1000).filter((l) => (l.quote_liquidity_usd || 0) >= 1000 || (l.volume_24h_usd || 0) >= 1000)].slice(0, 2000),
  };
  fs.writeFileSync(SNAP_PATH + '.tmp', JSON.stringify(snap));
  fs.renameSync(SNAP_PATH + '.tmp', SNAP_PATH);

  // prune
  db.prepare('DELETE FROM vol WHERE minute < ?').run(headTs - 2 * WINDOW_S);
  db.prepare('DELETE FROM sims WHERE ts < ?').run(headTs - 7 * 86400);
  db.prepare('DELETE FROM liq WHERE ts < ?').run(headTs - 2 * WINDOW_S);
  db.prepare('DELETE FROM pos WHERE pool_id IN (SELECT pool_id FROM pools WHERE created_ts < ?)').run(headTs - 2 * WINDOW_S);
  db.prepare("DELETE FROM pools WHERE created_ts < ? AND kind != 'uniswap-v4'").run(headTs - 2 * WINDOW_S);
  db.prepare("DELETE FROM pools WHERE created_ts < ?").run(headTs - KEEP_POOLS_S);
  db.close();
  log(`ok head=${headN} processed=${processed} created=${created} swaps=${swaps} sims=${simmed} launches24h=${launches.length} ${Date.now() - t0}ms rss=${Math.round(process.memoryUsage().rss / 1e6)}MB`);
}

// One-off seed: index pool CREATIONS only, going back N hours from the oldest block held,
// so the V4 pool-key index (and the honeypot check's V4 coverage) starts with history.
// Volume is never backfilled: it is counted from the first regular run onward.
//   node bin/base-launches-collect.js --backfill-hours=168
async function backfill(hours) {
  LOG_GAP_MS = Math.max(LOG_GAP_MS, 1200);
  const db = openDb();
  const labels = loadLabels();
  const head = await rpc(LOG_RPC, 'eth_getBlockByNumber', ['latest', false]);
  const headN = parseInt(head.number, 16); const headTs = parseInt(head.timestamp, 16);
  const tsOf = (b) => headTs - (headN - b) * 2;
  const oldest = db.prepare('SELECT MIN(created_block) AS b FROM pools').get().b || Number(getMeta(db, 'last_block') || headN);
  const stop = headN - Math.round(hours * 1800);
  const ins = db.prepare(`INSERT OR IGNORE INTO pools (pool_id, kind, token0, token1, fee, tick_spacing, hooks, stable, created_block, created_ts, tx_hash, launchpad, init_sqrt_price)
    VALUES (@pool_id, @kind, @token0, @token1, @fee, @tick_spacing, @hooks, @stable, @created_block, @created_ts, @tx_hash, @launchpad, @init_sqrt_price)`);
  let to = oldest - 1; let n = 0;
  while (to > stop && left() > 3000) {
    const from = Math.max(stop, to - MAX_SPAN + 1);
    const logs = await rpc(LOG_RPC, 'eth_getLogs', [{ address: [A.poolManager, A.v3Factory, A.aeroFactory, A.aeroCL, A.v2Factory], topics: [[T.v4Init, T.v3Created, T.aeroCreated, T.clCreated, T.v2Created]], fromBlock: hex(from), toBlock: hex(to) }]);
    const rows = logs.map(parseCreate).filter(Boolean).map((p) => ({ fee: null, tick_spacing: null, hooks: null, stable: null, init_sqrt_price: null, ...p, created_ts: tsOf(p.created_block), launchpad: p.hooks && labels.hooks[p.hooks] ? labels.hooks[p.hooks] : null }));
    db.transaction(() => { for (const r of rows) n += ins.run(r).changes; })();
    setMeta(db, 'first_block_ts', tsOf(from));
    to = from - 1;
  }
  db.close();
  log(`backfill ok: ${n} pools, now indexed from block ${to + 1} (${new Date(tsOf(to + 1) * 1000).toISOString()})${to > stop ? ' (deadline: run again to continue)' : ''}`);
}

// One-off: swaps and V4 positions for the N hours before regular runs began, for pools we
// hold, so the first day's volume and V4 quote liquidity are complete. Runs under the same
// flock as the cron job; it only covers blocks the regular runs never saw.
//   node bin/base-launches-collect.js --backfill-activity-hours=24
async function backfillActivity(hours) {
  LOG_GAP_MS = Math.max(LOG_GAP_MS, 1200);
  const db = openDb();
  const head = await rpc(LOG_RPC, 'eth_getBlockByNumber', ['latest', false]);
  const headN = parseInt(head.number, 16); const headTs = parseInt(head.timestamp, 16);
  const tsOf = (b) => headTs - (headN - b) * 2;
  const end = Number(getMeta(db, 'volume_from_block'));
  if (!end) throw new Error('no regular run yet: volume_from_block is not set');
  const stop = Math.max(headN - Math.round(hours * 1800), end - Math.round(hours * 1800));
  const pools = new Map(db.prepare('SELECT pool_id, kind, token0, token1 FROM pools WHERE created_ts >= ?').all(tsOf(stop)).map((p) => [p.pool_id, p]));
  let to = end - 1; let swaps = 0;
  while (to >= stop && left() > 8000) {
    const from = Math.max(stop, to - MAX_SPAN + 1);
    swaps += await activity(db, from, to, tsOf, pools);
    setMeta(db, 'volume_from_block', from); setMeta(db, 'volume_from_ts', tsOf(from));
    to = from - 1;
  }
  db.close();
  log(`activity backfill: ${swaps} swaps, counted from block ${to + 1} (${new Date(tsOf(to + 1) * 1000).toISOString()})${to >= stop ? ' (deadline: run again to continue)' : ''}`);
}

const bf = process.argv.find((a) => a.startsWith('--backfill-hours='));
const ba = process.argv.find((a) => a.startsWith('--backfill-activity-hours='));
if (require.main === module) (bf ? backfill(Number(bf.split('=')[1])) : ba ? backfillActivity(Number(ba.split('=')[1])) : main()).catch((e) => { log('ERROR', e && e.message); process.exitCode = 1; });

module.exports = { parseCreate, v4QuoteAmount, quoteOf, T, A };
