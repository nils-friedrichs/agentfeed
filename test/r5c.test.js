'use strict';
// R5 Phase C with no network: on-chain pool maths (Uniswap V3 legs, Orca/Raydium layouts with
// their mint check), the price module's median and its 503, the peg tape's price and liquidity,
// a transaction summary from standard RPC, and Hyperliquid symbol mapping.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const fresh = (rel) => { const p = require.resolve(path.join('..', rel)); delete require.cache[p]; return require(p); };
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
function sqrtHex(ratio) { // sqrt(ratio) * 2^96 as a 32-byte word
  const v = BigInt(Math.round(Math.sqrt(ratio) * 2 ** 48)) << 48n;
  return '0x' + v.toString(16).padStart(64, '0');
}

test('uniswap v3 leg: USD per asset from sqrtPriceX96, whichever side USDC is on', () => {
  const D = fresh('tools/dexspot.js');
  // WETH/USDC with USDC as token0 (Ethereum 0x88e6): token1 per token0 = WETH per USDC in base units
  const raw = (1 / 2500) * 10 ** (18 - 6);
  near(D._univ3Price(sqrtHex(raw), { baseIs0: false, baseDec: 18, quoteDec: 6 }), 2500, 1e-9);
  // WETH as token0 (Base 0xd0b5): token1 per token0 = USDC per WETH in base units
  near(D._univ3Price(sqrtHex(2500 * 10 ** (6 - 18)), { baseIs0: true, baseDec: 18, quoteDec: 6 }), 2500, 1e-9);
  // the configured BTC two-leg route multiplies BTC/WETH by WETH/USDC
  const btc = D.POOLS.BTC.find((p) => p.chain === 'ethereum');
  assert.equal(btc.legs.length, 2);
  const leg1 = D._univ3Price(sqrtHex(32.8 * 10 ** (18 - 8)), btc.legs[0]); // WBTC token0, WETH token1
  near(leg1, 32.8, 1e-9);
  near(leg1 * D._univ3Price(sqrtHex(raw), btc.legs[1]), 32.8 * 2500, 1e-9);
});

function poolAccount(layout, mintA, mintB, sqrtRatio) {
  const D = require('../tools/dexspot');
  const buf = Buffer.alloc(layout.size);
  const dec = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c)); const h = n.toString(16).padStart(64, '0'); return Buffer.from(h, 'hex'); };
  dec(mintA).copy(buf, layout.mintA); dec(mintB).copy(buf, layout.mintB);
  let v = BigInt(Math.round(Math.sqrt(sqrtRatio) * 2 ** 32)) << 32n;
  for (let i = 0; i < 16; i++) { buf[layout.sqrt + i] = Number(v & 0xffn); v >>= 8n; }
  assert.equal(D._b58(buf.subarray(layout.mintA, layout.mintA + 32)), mintA, 'test encoder round-trips');
  return buf;
}
const SOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('orca and raydium layouts: price from the sqrt price, and a pool whose mints do not match is refused', () => {
  const D = fresh('tools/dexspot.js');
  const orca = D.POOLS.SOL.find((p) => p.kind === 'whirlpool');
  const ray = D.POOLS.SOL.find((p) => p.kind === 'raydium-clmm');
  // 108 USDC per SOL = 108 * 1e6 / 1e9 USDC base units per lamport
  const ratio = 108 * 10 ** (6 - 9);
  near(D._solanaPrice(poolAccount({ size: 653, sqrt: 65, mintA: 101, mintB: 181 }, SOL, USDC, ratio), orca), 108, 1e-6);
  near(D._solanaPrice(poolAccount({ size: 1544, sqrt: 253, mintA: 73, mintB: 105 }, SOL, USDC, ratio), ray), 108, 1e-6);
  assert.throws(() => D._solanaPrice(poolAccount({ size: 653, sqrt: 65, mintA: 101, mintB: 181 }, USDC, SOL, ratio), orca), /mints do not match/);
});

test('prices: median of the pools that answered; none answering is a 503; unknown symbol is a 400', async () => {
  const dexPath = require.resolve('../tools/dexspot.js');
  const real = require(dexPath);
  let quotes = [];
  require.cache[dexPath].exports = { ...real, readPools: async () => ({ quotes, errors: quotes.length ? [] : ['all down'] }) };
  try {
    const P = fresh('tools/prices.js');
    quotes = [{ venue: 'a', chain: 'base', pair: 'X', pool: '0x1', price: 100 }, { venue: 'b', chain: 'ethereum', pair: 'X', pool: '0x2', price: 102 }, { venue: 'c', chain: 'base', pair: 'Y', pool: '0x3', price: 150 }];
    const q = await P.getPriceQuotes('BTC');
    assert.equal(q.price, 102, 'median, so one bad pool cannot move it');
    assert.equal(q.quotes.length, 3);
    const g = await P.getPrice('ETH');
    assert.deepEqual(Object.keys(g), ['symbol', 'price', 'confidence', 'publish_time', 'source']);
    const P2 = fresh('tools/prices.js');
    quotes = [];
    await assert.rejects(P2.getPrice('SOL'), (e) => e.status === 503);
    await assert.rejects(P2.getPrice('DOGE'), (e) => e.kind === 'bad_request');
  } finally { require.cache[dexPath].exports = real; }
});

test('peg tape: token price in USD and liquidity as both vaults at that price', () => {
  process.env.PEG_ONCHAIN_DB = path.join(require('os').tmpdir(), `peg-none-${process.pid}.db`);
  const O = fresh('tools/pegonchain.js');
  const p = { symbol: 'TSTx', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', decimals: 8, kind: 'raydium-clmm', quote: 'USDC', quote_mint: USDC, token_is_0: true };
  // 378 USDC per token: token1 (USDC, 6) per token0 (token, 8) in base units
  const buf = poolAccount({ size: 1544, sqrt: 253, mintA: 73, mintB: 105 }, p.mint, USDC, 378 * 10 ** (6 - 8));
  const r = O._priceOf(p, buf, 1000 * 1e8, 500000 * 1e6, 1);
  near(r.price_usd, 378, 1e-6);
  near(r.liq_usd, 1000 * 378 + 500000, 1e-6);
  // a SOL-quoted pool is priced through the SOL price
  const ps = { ...p, quote: 'SOL', quote_mint: SOL };
  const bs = poolAccount({ size: 1544, sqrt: 253, mintA: 73, mintB: 105 }, p.mint, SOL, 1.4 * 10 ** (9 - 8));
  near(O._priceOf(ps, bs, 1e8, 1e9, 108).price_usd, 1.4 * 108, 1e-6);
  assert.throws(() => O._priceOf(p, bs, 1, 1, 1), /mints do not match/);
});

test('wallet activity row: SOL and token changes for the wallet, fee, failure, named programs', () => {
  const SR = fresh('lib/solrpc.js');
  const W = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7';
  const t = { slot: 9, blockTime: 1791800000, transaction: { signatures: ['sig1'], message: { accountKeys: [{ pubkey: W }, { pubkey: 'other' }],
    instructions: [{ programId: 'ComputeBudget111111111111111111111111111111' }, { programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }, { programId: 'UnknownProgram1111111111111111111111111111' }] } },
    meta: { fee: 5000, err: null, preBalances: [2e9, 0], postBalances: [1.5e9 - 5000, 0],
      preTokenBalances: [{ owner: W, mint: USDC, uiTokenAmount: { uiAmountString: '10' } }], postTokenBalances: [{ owner: W, mint: USDC, uiTokenAmount: { uiAmountString: '64.5' } }, { owner: 'other', mint: SOL, uiTokenAmount: { uiAmountString: '3' } }] } };
  const r = SR.summarizeTx(t, W);
  assert.equal(r.fee_sol, 0.000005);
  assert.equal(r.sol_change, -0.500005);
  assert.deepEqual(r.token_changes, [{ mint: USDC, change: 54.5 }]);
  assert.deepEqual(r.programs, ['compute-budget', 'orca-whirlpool', 'UnknownProgram1111111111111111111111111111']);
  assert.equal(r.failed, false);
  assert.equal(r.fee_payer, true);
});

test('hyperliquid symbols: SOLUSDT -> SOL, 1000PEPEUSDT -> kPEPE, unlisted -> listed:false, a failure never throws', async (t) => {
  const real = global.fetch;
  let fail = false;
  global.fetch = async (url, init) => {
    if (fail) throw new Error('down');
    const b = JSON.parse(init.body);
    assert.equal(b.type, 'metaAndAssetCtxs');
    return new Response(JSON.stringify([{ universe: [{ name: 'SOL' }, { name: 'kPEPE' }] }, [{ markPx: '100', oraclePx: '100.1', openInterest: '10', funding: '0.0000125', prevDayPx: '95', dayNtlVlm: '1e6' }, { markPx: '0.004', openInterest: '1000' }]]));
  };
  t.after(() => { global.fetch = real; });
  const H = fresh('tools/hlperp.js');
  assert.equal(await H.coinFor('SOLUSDT'), 'SOL');
  assert.equal(await H.coinFor('1000PEPEUSDT'), 'kPEPE');
  assert.equal(await H.coinFor('1INCHUSDT'), null);
  const b = await H.block('SOLUSDT', async (c, x) => ({ oi_usd: x.oi_usd }));
  assert.deepEqual([b.coin, b.oi_usd], ['SOL', 1000]);
  assert.equal((await H.block('1INCHUSDT', async () => ({}))).listed, false);
  const u = await H.universe();
  assert.equal(u.find((r) => r.coin === 'SOL').funding_rate_8h, 0.0001);
  fail = true;
  fresh('lib/cache.js'); // the 30 s context cache lives there
  const H2 = fresh('tools/hlperp.js');
  const d = await H2.block('SOLUSDT', async () => ({}));
  assert.equal(d.available, false);
});
