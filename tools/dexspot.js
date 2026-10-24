// tools/dexspot.js — SOL, BTC and ETH in USD read from deep on-chain DEX pools (R5 C1).
//
// The CEX spot venues behind the price routes (Coinbase, Kraken, Binance, OKX, Gemini) all
// forbid redistributing their market data (docs/SOURCES.md), so spot now comes from the chains
// themselves: the current price of a concentrated-liquidity pool against USDC, read with
// standard RPC calls (eth_call slot0, getMultipleAccounts) and computed here. Nothing is bought
// from or passed through a data vendor; the RPC only carries chain state.
//
// Pools were chosen on 12 Oct 2026 by reading them on-chain, not from memory: for EVM,
// factory.getPool(token, USDC, fee) for every fee tier, then token0/token1 and the USDC held;
// for Solana, getProgramAccounts filtered on the SOL and USDC mints, then the USDC vault
// balance. The deepest active pool per chain is kept. A pool's price is its mid (the swap fee
// is not in it), so two pools on two chains differ by up to a few basis points.
'use strict';

const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';

// kind 'univ3': legs multiplied in order, each the price of its base in its quote; baseIs0 says
// whether the base is the pool's token0 (read from token0/token1). One leg is a direct USDC pool;
// two legs go through WETH, because the deepest BTC pools on Ethereum and Base are against WETH.
// kind 'whirlpool' / 'raydium-clmm': sqrt price is token B (resp. 1) per token A (resp. 0)
const POOLS = {
  SOL: [
    { venue: 'orca-whirlpool', chain: 'solana', pair: 'SOL/USDC', kind: 'whirlpool', address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', decA: 9, decB: 6, mintA: WSOL, mintB: USDC_SOL },
    { venue: 'raydium-clmm', chain: 'solana', pair: 'SOL/USDC', kind: 'raydium-clmm', address: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', decA: 9, decB: 6, mintA: WSOL, mintB: USDC_SOL },
  ],
  // The Ethereum WBTC/USDC 0.3% pool was tried first and dropped: its mid sat 0.47% under
  // Hyperliquid's BTC mid while the others sat within 0.3%, because a 0.3% fee band lets it drift.
  BTC: [
    { venue: 'uniswap-v3', chain: 'base', pair: 'cbBTC/USDC 0.05%', kind: 'univ3', address: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef',
      legs: [{ address: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', baseIs0: false, baseDec: 8, quoteDec: 6 }] },
    { venue: 'uniswap-v3', chain: 'ethereum', pair: 'WBTC/WETH 0.05% x WETH/USDC 0.05%', kind: 'univ3', address: '0x4585FE77225b41b697C938B018E2Ac67Ac5a20c0',
      legs: [{ address: '0x4585FE77225b41b697C938B018E2Ac67Ac5a20c0', baseIs0: true, baseDec: 8, quoteDec: 18 }, { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', baseIs0: false, baseDec: 18, quoteDec: 6 }] },
    { venue: 'uniswap-v3', chain: 'base', pair: 'cbBTC/WETH 0.05% x WETH/USDC 0.05%', kind: 'univ3', address: '0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1',
      legs: [{ address: '0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1', baseIs0: false, baseDec: 8, quoteDec: 18 }, { address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', baseIs0: true, baseDec: 18, quoteDec: 6 }] },
  ],
  ETH: [
    { venue: 'uniswap-v3', chain: 'ethereum', pair: 'WETH/USDC 0.05%', kind: 'univ3', address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
      legs: [{ address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', baseIs0: false, baseDec: 18, quoteDec: 6 }] },
    { venue: 'uniswap-v3', chain: 'base', pair: 'WETH/USDC 0.05%', kind: 'univ3', address: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
      legs: [{ address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', baseIs0: true, baseDec: 18, quoteDec: 6 }] },
  ],
};
// mainnet.base.org and eth.drpc.org are clean in docs/SOURCES.md; base.drpc.org is the Base fallback
const EVM_RPCS = { ethereum: ['https://eth.drpc.org'], base: ['https://mainnet.base.org', 'https://base.drpc.org'] };
const SR = require('../lib/solrpc');   // the Solana read: the failover endpoint list (R20); the EVM reads below keep their own RPCs

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message || JSON.stringify(j.error)).slice(0, 80));
  return j.result;
}

const SLOT0 = '0x3850c7bd';
// one leg's price, its quote per its base, from sqrtPriceX96 (= sqrt(token1/token0) in base units)
function univ3Price(sqrtHex, leg) {
  const s = Number(BigInt('0x' + sqrtHex.slice(2, 66))) / 2 ** 96;
  const raw = s * s;
  return leg.baseIs0 ? raw * 10 ** (leg.baseDec - leg.quoteDec) : 1 / (raw * 10 ** (leg.quoteDec - leg.baseDec));
}
async function slot0(chain, address) {
  let last;
  for (const url of EVM_RPCS[chain]) {
    try {
      const out = await rpc(url, 'eth_call', [{ to: address, data: SLOT0 }, 'latest']);
      if (!out || out.length < 66) throw new Error('empty slot0');
      return out;
    } catch (e) { last = e; }
  }
  throw last;
}
async function readUniv3(p, memo) {
  let price = 1;
  for (const leg of p.legs) {
    const key = `${p.chain}:${leg.address.toLowerCase()}`;
    if (!memo.has(key)) memo.set(key, slot0(p.chain, leg.address));
    price *= univ3Price(await memo.get(key), leg);
  }
  return price;
}

const u128 = (b, o) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
// Orca Whirlpool: sqrt_price u128 at 65, token_mint_a at 101, token_mint_b at 181 (8-byte discriminator first)
// Raydium CLMM PoolState: token_mint_0 at 73, token_mint_1 at 105, sqrt_price_x64 u128 at 253
const LAYOUT = { whirlpool: { sqrt: 65, mintA: 101, mintB: 181 }, 'raydium-clmm': { sqrt: 253, mintA: 73, mintB: 105 } };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex')); let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of buf) { if (x === 0) s = '1' + s; else break; }
  return s;
}
function solanaPrice(data, p) {
  const L = LAYOUT[p.kind];
  // the mints are checked on every read: a wrong address or a changed layout must fail, not misprice
  if (b58(data.subarray(L.mintA, L.mintA + 32)) !== p.mintA || b58(data.subarray(L.mintB, L.mintB + 32)) !== p.mintB) throw new Error('pool mints do not match');
  const s = Number(u128(data, L.sqrt)) / 2 ** 64;
  return s * s * 10 ** (p.decA - p.decB);
}
async function readSolana(pools) {
  const res = await SR.rpc('getMultipleAccounts', [pools.map((p) => p.address), { encoding: 'base64', commitment: 'confirmed' }], { timeoutMs: 5000 });
  return pools.map((p, i) => {
    const acc = res && res.value && res.value[i];
    if (!acc) return { error: 'account not found' };
    try { return { price: solanaPrice(Buffer.from(acc.data[0], 'base64'), p), slot: res.context && res.context.slot }; } catch (e) { return { error: e.message }; }
  });
}

/** -> [{ venue, chain, pair, pool, price } ...] for every pool that answered; failures in .errors */
async function readPools(symbol) {
  const pools = POOLS[symbol];
  const sol = pools.filter((p) => p.chain === 'solana');
  const evm = pools.filter((p) => p.chain !== 'solana');
  const out = []; const errors = [];
  const [solRes, evmRes] = await Promise.all([
    sol.length ? readSolana(sol).catch((e) => sol.map(() => ({ error: e.message }))) : [],
    (() => { const memo = new Map(); return Promise.all(evm.map((p) => readUniv3(p, memo).then((price) => ({ price }), (e) => ({ error: e.message })))); })(),
  ]);
  [...sol.map((p, i) => [p, solRes[i]]), ...evm.map((p, i) => [p, evmRes[i]])].forEach(([p, r]) => {
    if (r && Number.isFinite(r.price) && r.price > 0) out.push({ venue: p.venue, chain: p.chain, pair: p.pair, pool: p.address, price: r.price, ...(r.slot ? { slot: r.slot } : {}) });
    else errors.push(`${p.venue} ${p.chain}: ${(r && r.error) || 'no price'}`);
  });
  return { quotes: out, errors };
}

module.exports = { POOLS, readPools, _univ3Price: univ3Price, _solanaPrice: solanaPrice, _b58: b58 };
