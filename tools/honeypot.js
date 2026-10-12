// tools/honeypot.js — /api/honeypot-check: can a Base token be bought AND sold right now? (R3, 2026-10-12)
//
// THE PRODUCT IS OUR OWN SIMULATION. contracts/HoneypotSim.sol is placed at a throwaway
// address with an eth_call state override and run once against the token's deepest pool:
// buy with about $10 of the pool's quote asset, send 1% to another wallet, sell 99% of the
// rest back. Nothing is broadcast. Buy tax = what the pool sent vs what arrived; sell tax =
// what we sent vs what the pool was credited; round-trip loss also includes pool fees and
// price impact. All reads are pinned to one block.
//
// SOURCES, AND WHY ONLY THESE. Everything is read from Base itself: mainnet.base.org, with
// base.gateway.tenderly.co as fallback. GoPlus, honeypot.is and DexScreener were the brief's
// cross-checks and pool finder; their API terms (read 2026-10-12) forbid commercial use of
// their data (GoPlus), resale or third-party access (honeypot.is) and selling or making
// any portion of the API available to third parties (DexScreener), so none is called. The
// cross-check is our own: the simulation against the deployed bytecode, and every
// contradiction between them is listed under `disagreements`.
//
// POOLS. Uniswap V2 pairs, Uniswap V3 pools, Aerodrome v2 and Slipstream pools are found by
// asking each factory (WETH and USDC quotes). Uniswap V4 pools are found in our own index
// of PoolManager Initialize events (bin/base-launches-collect.js), so a V4 pool created
// before that collector started is not seen. The deepest pool by quote-side liquidity wins.
//
// CONTRACT. A finding, including "no pool found", is 200 and billable. Base RPC failing on
// both nodes is 503. A malformed address, an address with no contract, or an unsupported
// chain is 400. All of 4xx/5xx are never settled.
'use strict';
const V = require('viem');
const path = require('node:path');
const SIM = require('../contracts/honeypot-sim.json');

// One line per chain. bsc and ethereum are added by appending their entry here.
const CHAINS = {
  base: {
    id: 8453, name: 'Base',
    rpcs: [process.env.BASE_SIM_RPC || 'https://mainnet.base.org', 'https://base.gateway.tenderly.co'],
    weth: '0x4200000000000000000000000000000000000006',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', usdcBalanceSlot: 9n,
    multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    ethUsdPool: '0xd0b53D9277642d899DF5C87A3966A349A798F224',   // Uniswap V3 WETH/USDC 0.05%
    v2: { factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', feeBps: 30n },
    v3: { factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', fees: [100, 500, 3000, 10000] },
    aero: { factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
    aeroCL: { factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', spacings: [1, 50, 100, 200, 2000] },
    v4: { poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b', stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71' },
  },
};

const SIM_ADDR = '0xa402a402a402a402a402a402a402a402a402a402';
const FROM = '0x000000000000000000000000000000000000a402';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const CACHE_MS = 5 * 60 * 1000;
const PROBE_USD = 10;
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const V4_DB = () => process.env.BASE_LAUNCHES_DB || path.join(__dirname, '..', 'baselaunches.db');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });

const ABI = V.parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[])',
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function paused() view returns (bool)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
]);
const RUN_ABI = [{
  type: 'function', name: 'run', stateMutability: 'nonpayable',
  inputs: [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
  outputs: [{ type: 'tuple', components: [
    { name: 'buy', type: 'tuple', components: [{ name: 'ok', type: 'bool' }, { name: 'err', type: 'bytes' }, { name: 'sent', type: 'uint256' }, { name: 'arrived', type: 'uint256' }, { name: 'received', type: 'uint256' }, { name: 'gasUsed', type: 'uint256' }] },
    { name: 'sell', type: 'tuple', components: [{ name: 'ok', type: 'bool' }, { name: 'err', type: 'bytes' }, { name: 'sent', type: 'uint256' }, { name: 'arrived', type: 'uint256' }, { name: 'received', type: 'uint256' }, { name: 'gasUsed', type: 'uint256' }] },
    { name: 'transferOk', type: 'bool' }, { name: 'transferErr', type: 'bytes' },
  ] }],
}];
const POOLKEY = [{ type: 'address' }, { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }];
const KIND = { 'uniswap-v2': 1, 'aerodrome-v2': 2, 'uniswap-v3': 3, 'aerodrome-cl': 3, 'uniswap-v4': 4 };

// selectors present in deployed bytecode -> what the function can do
const FLAG_SELECTORS = {
  mint: { '40c10f19': 'mint(address,uint256)', a0712d68: 'mint(uint256)', '449a52f8': 'mintTo(address,uint256)' },
  blacklist: { f9f92be4: 'blacklist(address)', '44337ea1': 'addToBlacklist(address)', fe575a87: 'isBlacklisted(address)', '153b0d1e': 'setBlacklist(address,bool)', '455a4396': 'blacklistAddress(address,bool)', bfd79284: 'bots(address)', '9c0db5f3': 'setBots(address[],bool)', d34628cc: 'addBots(address[])' },
  pause: { '8456cb59': 'pause()', '5c975abb': 'paused()', '3f4ba83a': 'unpause()' },
  tax_setter: { '69fe0e2d': 'setFee(uint256)', '0b78f9c0': 'setFees(uint256,uint256)', c647b20e: 'setTaxes(uint256,uint256)', dc1052e2: 'setBuyTax(uint256)', '8cd09d50': 'setSellTax(uint256)', '6db79437': 'updateFees(uint256,uint256)' },
  limits: { ec28438a: 'setMaxTxAmount(uint256)', ea1644d5: 'setMaxWalletSize(uint256)' },
  trading_switch: { '8a8c523c': 'enableTrading()', c9567bf9: 'openTrading()' },
  upgradeable: { '3659cfe6': 'upgradeTo(address)', '4f1ef286': 'upgradeToAndCall(address,bytes)' },
};
const ERRORS = { e450d38c: 'ERC20InsufficientBalance(address,uint256,uint256)', fb8f41b2: 'ERC20InsufficientAllowance(address,uint256,uint256)', '96c6fd1e': 'ERC20InvalidSender(address)', ec442f05: 'ERC20InvalidReceiver(address)', '118cdaa7': 'OwnableUnauthorizedAccount(address)', d93c0665: 'EnforcedPause()', '12f1f923': 'TradingNotEnabled()', e09f0331: 'TradingNotOpen()', '801bc44b': 'MaxTxAmountExceeded()', '2ce93b59': 'MaxWalletExceeded()', '5212cba1': 'CurrencyNotSettled()', '486aa307': 'PoolNotInitialized()', '90b8ec18': 'TransferFailed()', '48f5c3ed': 'InvalidCaller()', '7c9c6e8f': 'PriceLimitAlreadyExceeded(uint160,uint160)', a932492f: 'K()', '27dc822c': 'INSUFFICIENT_OUTPUT_AMOUNT()' };

// ---- RPC: one block for every read; fallback node on failure ----
async function rpc(chain, method, params, { node } = {}) {
  const order = node != null ? [chain.rpcs[node]] : chain.rpcs;
  let last;
  for (const url of order) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
      const j = await r.json().catch(() => null);
      if (j && 'result' in j) return { result: j.result, url };
      // a revert is an answer, not a node failure
      if (j && j.error && /revert|execution/i.test(String(j.error.message))) return { error: j.error, url };
      last = new Error(`${new URL(url).host}: ${j && j.error ? j.error.message : `HTTP ${r.status}`}`);
    } catch (e) { last = e; }
  }
  throw unavailable(`Base RPC unavailable (${String(last && last.message).slice(0, 120)}). Not charged.`);
}
const hexBlock = (n) => '0x' + n.toString(16);

async function multicall(chain, block, calls) {
  const data = V.encodeFunctionData({ abi: ABI, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))] });
  const { result, error } = await rpc(chain, 'eth_call', [{ to: chain.multicall, data }, hexBlock(block)]);
  if (error) throw unavailable('multicall reverted');
  const out = V.decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: result });
  return out.map((o, i) => {
    if (!o.success || o.returnData === '0x') return null;
    try { return V.decodeFunctionResult({ abi: ABI, functionName: calls[i].fn, args: calls[i].args, data: o.returnData }); } catch { return null; }
  });
}
const call = (target, fn, args = []) => ({ target, fn, args, data: V.encodeFunctionData({ abi: ABI, functionName: fn, args }) });

// ---- revert data -> readable ----
function decodeRevert(hex) {
  if (!hex || hex === '0x') return { reason: 'reverted without a reason' };
  const sel = hex.slice(2, 10);
  try {
    if (sel === '08c379a0') return { reason: V.decodeAbiParameters([{ type: 'string' }], '0x' + hex.slice(10))[0] };
    if (sel === '4e487b71') return { reason: `panic 0x${V.decodeAbiParameters([{ type: 'uint256' }], '0x' + hex.slice(10))[0].toString(16)}` };
    if (sel === '90bfb865') { // V4 WrappedError(address target, bytes4 selector, bytes reason, bytes details)
      const [target, , reason] = V.decodeAbiParameters([{ type: 'address' }, { type: 'bytes4' }, { type: 'bytes' }, { type: 'bytes' }], '0x' + hex.slice(10));
      const inner = decodeRevert(reason);
      return { reason: `${inner.reason} (raised by ${target})`, selector: inner.selector };
    }
    if (sel === 'e450d38c' || sel === 'fb8f41b2') { // OpenZeppelin v5: (address, have, need)
      const [who, have, need] = V.decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], '0x' + hex.slice(10));
      return { reason: `${ERRORS[sel].split('(')[0]}: ${who} has ${have}, needs ${need}`, selector: '0x' + sel };
    }
  } catch { /* fall through to the selector */ }
  return { reason: ERRORS[sel] || `custom error 0x${sel}`, selector: '0x' + sel };
}

// ---- bytecode: PUSH4 values, skipping PUSH data correctly ----
function push4s(code) {
  const b = Buffer.from(code.replace(/^0x/, ''), 'hex');
  const out = new Set();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4 && i + 4 < b.length) out.add(b.subarray(i + 1, i + 5).toString('hex'));
      i += n;
    }
  }
  return out;
}

async function contractFlags(chain, block, token, code) {
  let proxy = null;
  let impl = null;
  const c = code.replace(/^0x/, '').toLowerCase();
  if (c.startsWith('363d3d373d3d3d363d73')) { proxy = 'eip1167_minimal'; impl = '0x' + c.slice(20, 60); }
  if (!impl) {
    const [s1, s2] = await Promise.all([rpc(chain, 'eth_getStorageAt', [token, IMPL_SLOT, hexBlock(block)]), rpc(chain, 'eth_getStorageAt', [token, BEACON_SLOT, hexBlock(block)])]);
    const a1 = '0x' + String(s1.result || '').slice(-40);
    const a2 = '0x' + String(s2.result || '').slice(-40);
    if (/[1-9a-f]/.test(a1.slice(2))) { proxy = 'eip1967'; impl = a1; } else if (/[1-9a-f]/.test(a2.slice(2))) { proxy = 'eip1967_beacon'; impl = a2; }
  }
  let implCode = null;
  if (impl && proxy !== 'eip1967_beacon') implCode = (await rpc(chain, 'eth_getCode', [impl, hexBlock(block)])).result;
  const sels = new Set([...push4s(code), ...(implCode ? push4s(implCode) : [])]);
  const found = {};
  for (const [flag, map] of Object.entries(FLAG_SELECTORS)) found[flag] = Object.entries(map).filter(([s]) => sels.has(s)).map(([, sig]) => sig);
  const [owner, getOwner, paused] = await multicall(chain, block, [call(token, 'owner'), call(token, 'getOwner'), call(token, 'paused')]);
  const own = owner || getOwner || null;
  const renounced = own == null ? null : [ZERO, DEAD].includes(String(own).toLowerCase());
  return {
    proxy: proxy ? { kind: proxy, implementation: impl } : null,
    owner: own, owner_renounced: renounced,
    mintable: found.mint.length > 0,
    blacklist: found.blacklist.length > 0,
    pausable: found.pause.length > 0, paused: typeof paused === 'boolean' ? paused : null,
    tax_changeable: found.tax_setter.length > 0,
    limits_changeable: found.limits.length > 0,
    trading_switch: found.trading_switch.length > 0,
    upgradeable: !!proxy || found.upgradeable.length > 0,
    functions_found: Object.fromEntries(Object.entries(found).filter(([, v]) => v.length)),
    bytecode_bytes: (code.length - 2) / 2 + (implCode ? (implCode.length - 2) / 2 : 0),
    note: 'A flag means the function selector is present in the deployed bytecode (and the implementation, behind a proxy): the function exists, not that it has been used. Source code is not read.',
  };
}

// ---- pools ----
const V4_DB_OPEN = { db: null, at: 0 };
function v4Pools(chain, token) {
  try {
    const Database = require('better-sqlite3');
    if (!V4_DB_OPEN.db) V4_DB_OPEN.db = new Database(V4_DB(), { readonly: true, fileMustExist: true });
    const t = token.toLowerCase();
    const rows = V4_DB_OPEN.db.prepare(`SELECT pool_id, token0, token1, fee, tick_spacing, hooks, launchpad, created_ts FROM pools WHERE kind = 'uniswap-v4' AND (token0 = ? OR token1 = ?) ORDER BY created_ts DESC LIMIT 10`).all(t, t);
    const since = V4_DB_OPEN.db.prepare(`SELECT v FROM meta WHERE k = 'first_block_ts'`).get();
    const lq = V4_DB_OPEN.db.prepare('SELECT liquidity_usd AS usd, basis, ts FROM liq WHERE pool_id = ?');
    const liq = {};
    for (const r of rows) { const x = lq.get(r.pool_id); if (x) liq[r.pool_id] = x; }
    return { rows, since: since ? Number(since.v) : null, liq };
  } catch {
    return { rows: [], since: null, liq: {}, unavailable: true };
  }
}

async function ethUsd(chain, block) {
  const [s] = await multicall(chain, block, [call(chain.ethUsdPool, 'slot0')]);
  if (!s) throw unavailable('ETH/USD read from the WETH/USDC pool failed');
  const sp = Number(s[0]) / 2 ** 96;
  return sp * sp * 1e12; // token0 WETH (18), token1 USDC (6)
}

async function findPools(chain, block, token, usdPerEth) {
  const quotes = [chain.weth, chain.usdc];
  const SIG = {
    'uniswap-v2': V.parseAbi(['function getPair(address,address) view returns (address)']),
    'uniswap-v3': V.parseAbi(['function getPool(address,address,uint24) view returns (address)']),
    'aerodrome-v2': V.parseAbi(['function getPool(address,address,bool) view returns (address)']),
    'aerodrome-cl': V.parseAbi(['function getPool(address,address,int24) view returns (address)']),
  };
  const meta = [];
  for (const q of quotes) {
    meta.push({ venue: 'uniswap-v2', quote: q, target: chain.v2.factory, args: [token, q] });
    for (const f of chain.v3.fees) meta.push({ venue: 'uniswap-v3', quote: q, fee: f, target: chain.v3.factory, args: [token, q, f] });
    for (const st of [false, true]) meta.push({ venue: 'aerodrome-v2', quote: q, stable: st, target: chain.aero.factory, args: [token, q, st] });
    for (const ts of chain.aeroCL.spacings) meta.push({ venue: 'aerodrome-cl', quote: q, tickSpacing: ts, target: chain.aeroCL.factory, args: [token, q, ts] });
  }
  const calls = meta.map((m) => ({ target: m.target, abi: SIG[m.venue], data: V.encodeFunctionData({ abi: SIG[m.venue], functionName: SIG[m.venue][0].name, args: m.args }) }));
  const raw = await multicallRaw(chain, block, calls);
  const found = [];
  raw.forEach((r, i) => {
    if (!r) return;
    let a;
    try { a = V.decodeFunctionResult({ abi: calls[i].abi, functionName: calls[i].abi[0].name, data: r }); } catch { return; }
    if (a && a.toLowerCase() !== ZERO) { const { target, args, ...m } = meta[i]; found.push({ ...m, pool: a }); }
  });
  // quote-side balance of each pool
  const bals = found.length ? await multicall(chain, block, found.map((p) => call(p.quote, 'balanceOf', [p.pool]))) : [];
  const out = found.map((p, i) => {
    const raw = bals[i] == null ? 0n : bals[i];
    const quoteAmt = p.quote === chain.usdc ? Number(raw) / 1e6 : Number(raw) / 1e18;
    const usd = p.quote === chain.usdc ? quoteAmt : quoteAmt * usdPerEth;
    return { ...p, kind: KIND[p.venue], quote_symbol: p.quote === chain.usdc ? 'USDC' : 'WETH', quote_liquidity_usd: Math.round(usd * 100) / 100, liquidity_basis: 'quote asset held by the pool' };
  });

  // V4 from our own Initialize index
  const v4 = v4Pools(chain, token);
  const v4c = [];
  for (const r of v4.rows) {
    const other = r.token0 === token.toLowerCase() ? r.token1 : r.token0;
    const quote = other === ZERO ? ZERO : other === chain.weth.toLowerCase() ? chain.weth : other === chain.usdc.toLowerCase() ? chain.usdc : null;
    if (!quote) continue;
    v4c.push({ venue: 'uniswap-v4', kind: 4, pool: r.pool_id, quote, key: { currency0: V.getAddress(r.token0), currency1: V.getAddress(r.token1), fee: r.fee, tickSpacing: r.tick_spacing, hooks: V.getAddress(r.hooks) }, launchpad: r.launchpad });
  }
  if (v4c.length) {
    const st = await multicall(chain, block, v4c.flatMap((p) => [call(chain.v4.stateView, 'getSlot0', [p.pool]), call(chain.v4.stateView, 'getLiquidity', [p.pool])]));
    v4c.forEach((p, i) => {
      const s0 = st[2 * i]; const L = st[2 * i + 1];
      if (!s0 || L == null || s0[0] === 0n) return;
      const quoteSym = p.quote === ZERO ? 'ETH' : p.quote === chain.usdc ? 'USDC' : 'WETH';
      // the collector prices the quote side from the pool's own positions; that wins
      const known = v4.liq[p.pool];
      if (L === 0n) { out.push({ ...p, quote_symbol: quoteSym, quote_liquidity_usd: 0, liquidity_basis: 'no in-range liquidity (StateView getLiquidity = 0)' }); return; }
      if (known && known.basis === 'v4_positions_quote_side' && known.usd != null) { out.push({ ...p, quote_symbol: quoteSym, quote_liquidity_usd: known.usd, liquidity_basis: `quote asset held by the pool's positions, from our index at ${new Date(known.ts * 1000).toISOString()}` }); return; }
      const sp = Number(s0[0]) / 2 ** 96;
      const quoteIs1 = p.key.currency1.toLowerCase() === p.quote.toLowerCase();
      const virt = quoteIs1 ? Number(L) * sp : Number(L) / sp; // virtual reserve of the quote side, raw units
      const dec = p.quote === chain.usdc ? 1e6 : 1e18;
      const usd = (virt / dec) * (p.quote === chain.usdc ? 1 : usdPerEth);
      out.push({ ...p, quote_symbol: quoteSym, quote_liquidity_usd: Math.round(usd * 100) / 100, liquidity_basis: 'in-range virtual reserve of the quote side at the current price: an upper bound, the pool may hold less' });
    });
  }
  out.sort((a, b) => b.quote_liquidity_usd - a.quote_liquidity_usd);
  return { pools: out, v4Index: { since: v4.since ? new Date(v4.since * 1000).toISOString() : null, unavailable: !!v4.unavailable } };
}

async function multicallRaw(chain, block, calls) {
  const data = V.encodeFunctionData({ abi: ABI, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))] });
  const { result, error } = await rpc(chain, 'eth_call', [{ to: chain.multicall, data }, hexBlock(block)]);
  if (error) throw unavailable('multicall reverted');
  return V.decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: result }).map((o) => (o.success && o.returnData !== '0x' ? o.returnData : null));
}

// ---- the simulation ----
async function simulate(chain, block, token, p, usdPerEth) {
  const isUsdc = p.quote === chain.usdc;
  const usdIn = Math.max(1, Math.min(PROBE_USD, (p.quote_liquidity_usd || 0) / 100)); // $10, or 1% of the quote side if thinner
  const amountIn = isUsdc ? BigInt(Math.round(usdIn * 1e6)) : BigInt(Math.round((usdIn / usdPerEth) * 1e18));
  const v4 = p.kind === 4 ? V.encodeAbiParameters(POOLKEY, [chain.v4.poolManager, p.key]) : '0x';
  const data = V.encodeFunctionData({ abi: RUN_ABI, functionName: 'run', args: [p.kind, p.kind === 4 ? chain.v4.poolManager : p.pool, token, p.quote, amountIn, p.venue === 'uniswap-v2' ? chain.v2.feeBps : 0n, v4] });
  const override = { [SIM_ADDR]: { code: SIM.runtime, balance: '0x56bc75e2d63100000' } };
  if (isUsdc) {
    const slot = V.keccak256(V.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [SIM_ADDR, chain.usdcBalanceSlot]));
    override[chain.usdc] = { stateDiff: { [slot]: V.toHex(amountIn * 10n, { size: 32 }) } };
  }
  const tx = { from: FROM, to: SIM_ADDR, data, gas: '0x1c9c380' };
  const { result, error, url } = await rpc(chain, 'eth_call', [tx, hexBlock(block), override]);
  if (error) {
    // the simulator catches every leg; a revert here means the run itself failed
    throw unavailable(`simulation could not run: ${String(error.message).slice(0, 160)}`);
  }
  const r = V.decodeFunctionResult({ abi: RUN_ABI, functionName: 'run', data: result });
  return { r, amountIn, usdIn, rpc: new URL(url).host };
}

const pct = (num, den) => (den > 0n ? Math.round((1 - Number(num) / Number(den)) * 10000) / 100 : null);
const leg = (l) => (l.ok ? { ok: true, gas: Number(l.gasUsed) } : { ok: false, revert: decodeRevert(l.err).reason, gas: Number(l.gasUsed) });

function verdictOf(s) {
  if (!s) return { verdict: 'no_pool_found', sellable: null };
  const { buy, sell } = s.r;
  if (!buy.ok) return { verdict: 'buy_failed', sellable: null };
  if (buy.received === 0n) return { verdict: 'buy_failed', sellable: null };
  if (!sell.ok) return { verdict: 'not_sellable', sellable: false };
  const sellTax = pct(sell.arrived, sell.sent);
  if (sellTax != null && sellTax >= 90) return { verdict: 'not_sellable', sellable: false };
  if (sellTax != null && sellTax >= 50) return { verdict: 'extreme_tax', sellable: true };
  const buyTax = pct(buy.received, buy.arrived);
  if ((sellTax || 0) >= 10 || (buyTax || 0) >= 10) return { verdict: 'high_tax', sellable: true };
  return { verdict: 'sellable', sellable: true };
}

function disagreementsOf(v, c, s) {
  const out = [];
  if (!s || !c) return out;
  const sold = v.sellable === true;
  if (sold && c.blacklist) out.push(`The simulated sell went through, but the contract has blacklist functions (${c.functions_found.blacklist.join(', ')}): a holder can still be blocked later.`);
  if (sold && c.tax_changeable) out.push(`The simulated taxes are what the token charges now, but it has tax setters (${c.functions_found.tax_setter.join(', ')}): the owner can raise them.`);
  if (sold && c.pausable && c.owner_renounced === false) out.push('Transfers worked in the simulation, but the contract is pausable and has a live owner.');
  if (sold && c.upgradeable && c.owner_renounced === false) out.push('The token is upgradeable: the code that sold fine can be replaced.');
  if (v.verdict === 'not_sellable' && !c.blacklist && !c.tax_changeable && !c.pausable) out.push('The sell failed although no blacklist, tax setter or pause function was found in the bytecode: the block is in custom code or in the pool, check the revert reason.');
  if (s.r.transferOk === false && sold) out.push('Selling into the pool worked but a plain wallet-to-wallet transfer failed.');
  return out;
}

const cache = new Map();
const inflight = new Map();

async function getHoneypotCheck(p = {}) {
  const token = String(p.token || '').trim();
  const chainName = String(p.chain || 'base').trim().toLowerCase();
  if (!token) throw bad('missing required parameter: token, a 0x token contract address on Base, e.g. token=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed');
  if (!ADDR_RE.test(token)) throw bad('token must be a 0x contract address (40 hex characters)');
  const chain = CHAINS[chainName];
  if (!chain) throw bad(`chain ${chainName} is not supported yet; supported: ${Object.keys(CHAINS).join(', ')}`);
  const key = `${chainName}:${token.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };
  if (inflight.has(key)) return inflight.get(key);
  const job = run(chain, chainName, V.getAddress(token)).then((value) => {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function run(chain, chainName, token) {
  const blk = (await rpc(chain, 'eth_getBlockByNumber', ['latest', false])).result;
  const block = parseInt(blk.number, 16);
  const at = new Date(parseInt(blk.timestamp, 16) * 1000).toISOString();
  const code = (await rpc(chain, 'eth_getCode', [token, hexBlock(block)])).result;
  if (!code || code === '0x') throw bad(`no contract deployed at ${token} on ${chain.name}`);
  const [name, symbol, decimals, supply] = await multicall(chain, block, [call(token, 'name'), call(token, 'symbol'), call(token, 'decimals'), call(token, 'totalSupply')]);
  const usdPerEth = await ethUsd(chain, block);
  const [{ pools, v4Index }, contract] = await Promise.all([findPools(chain, block, token, usdPerEth), contractFlags(chain, block, token, code)]);

  const best = pools.find((x) => x.quote_liquidity_usd > 0) || null;
  let sim = null;
  if (best) sim = await simulate(chain, block, token, best, usdPerEth);
  const v = !best && pools.length ? { verdict: 'no_liquidity', sellable: null } : verdictOf(sim);
  const r = sim && sim.r;
  const dec = typeof decimals === 'number' ? decimals : null;
  const qdec = best && best.quote === chain.usdc ? 6 : 18;
  return {
    chain: chainName, token, name: name || null, symbol: symbol || null, decimals: dec,
    total_supply: supply != null && dec != null ? Number(supply) / 10 ** dec : null,
    verdict: v.verdict, sellable: v.sellable,
    buy_tax_pct: r && r.buy.ok ? pct(r.buy.received, r.buy.arrived) : null,
    sell_tax_pct: r && r.sell.ok ? pct(r.sell.arrived, r.sell.sent) : null,
    transfer_ok: r && r.buy.ok ? r.transferOk : null,
    // what came back against what the sold share of the buy cost
    round_trip_loss_pct: r && r.sell.ok && r.buy.received > 0n ? pct(r.sell.received, (r.buy.sent * r.sell.sent) / r.buy.received) : null,
    simulation: sim ? {
      pool: best.pool, venue: best.venue, quote: best.quote_symbol,
      amount_in: Number(sim.amountIn) / 10 ** qdec, amount_in_usd: Math.round(sim.usdIn * 100) / 100,
      buy: leg(r.buy), sell: r.buy.ok ? leg(r.sell) : null,
      transfer: r.buy.ok ? (r.transferOk ? { ok: true } : { ok: false, revert: decodeRevert(r.transferErr).reason }) : null,
      method: `eth_call at block ${block} with a state override that places our simulator contract at ${SIM_ADDR}: buy, send 1% to another address, sell 99% of the rest into the same pool. Nothing is broadcast. Taxes compare what each side sent with what arrived; round-trip loss also includes pool fees and price impact.`,
      rpc: sim.rpc, simulator_source_sha256: SIM.source_sha256,
    } : null,
    pool: best ? {
      address: best.pool, venue: best.venue, quote: best.quote_symbol, quote_liquidity_usd: best.quote_liquidity_usd, liquidity_basis: best.liquidity_basis,
      ...(best.key ? { v4_pool_key: best.key, launchpad: best.launchpad || null } : {}),
      pools_found: pools.length,
      others: pools.filter((x) => x !== best).slice(0, 3).map((x) => ({ address: x.pool, venue: x.venue, quote: x.quote_symbol, quote_liquidity_usd: x.quote_liquidity_usd })),
    } : pools.length ? {
      pools_found: pools.length, note: 'Every pool found holds no quote liquidity: nothing can be sold into them right now (liquidity removed, or never added on the quote side).',
      pools: pools.slice(0, 5).map((x) => ({ address: x.pool, venue: x.venue, quote: x.quote_symbol, quote_liquidity_usd: x.quote_liquidity_usd, liquidity_basis: x.liquidity_basis })),
    } : { pools_found: 0, searched: 'Uniswap V2, Uniswap V3 (4 fee tiers), Aerodrome v2 (stable and volatile), Aerodrome Slipstream (5 tick spacings) against WETH and USDC, and Uniswap V4 pools in our own Initialize index', v4_index_since: v4Index.since },
    contract,
    disagreements: disagreementsOf(v, contract, sim),
    as_of: { block, at, simulation: sim ? { block, at } : null, contract: { block, at }, pools: { block, at, v4_index_since: v4Index.since } },
    sources: ['Base chain reads (mainnet.base.org, base.gateway.tenderly.co fallback)', 'our simulator contract (contracts/HoneypotSim.sol), run with eth_call state overrides', 'our Uniswap V4 Initialize index'],
  };
}

module.exports = { getHoneypotCheck, CHAINS, _push4s: push4s, _decodeRevert: decodeRevert, _verdictOf: verdictOf };
