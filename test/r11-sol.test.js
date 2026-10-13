// test/r11-sol.test.js — the Solana pre-trade pack against a scripted RPC (R11 A6). No network.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tools/solpretrade');
const K = require('@solana/kit');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WALLET = ['4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', 'ASCQRp616JVQKMpynYfcPVdKPext719WUf7CuFcnnatX', 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu'];
const POOL_AUTH = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'; // off the ed25519 curve
const BURN = '1nc1nerator11111111111111111111111111111111';
const V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const key = (n) => { const b = Buffer.alloc(32); b[0] = 7; b.writeUInt32LE(n, 1); return T.b58encode ? T.b58encode(b) : require('../tools/dexspot')._b58(b); };
const put = (buf, o, addr) => T.b58decode(addr).copy(buf, o);
const u128 = (buf, o, v) => { for (let i = 0; i < 16; i++) { buf[o + i] = Number(v & 0xffn); v >>= 8n; } };

// ---- scripted chain ----
function chain(over = {}) {
  const c = { mintAuth: null, freezeAuth: null, ext: [], decimals: 6, supply: '1000000000000000', pools: [], accounts: new Map(), curve: null, largest: [], owners: new Map(), sigs: new Map(), txs: new Map(), calls: [], ...over };
  c.rpc = async (method, params) => {
    c.calls.push(method);
    if (method === 'getAccountInfo') {
      const [k, o] = params;
      if (k === MINT || k === c.mint) return { value: { owner: c.program || TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: { decimals: c.decimals, supply: c.supply, mintAuthority: c.mintAuth, freezeAuthority: c.freezeAuth, extensions: c.ext } } } } };
      if (c.curve && k === c.curve.pda) return { value: { owner: PUMP, data: [c.curve.data.toString('base64'), 'base64'] } };
      return { value: null };
    }
    if (method === 'getProgramAccounts') {
      const [program, { filters }] = params; const mc = filters.find((f) => f.memcmp).memcmp; const size = (filters.find((f) => f.dataSize) || {}).dataSize;
      return c.pools.filter((p) => p.program === program && (!size || p.data.length === size || p.slice) && T.keyAt(p.data, mc.offset) === mc.bytes).map((p) => ({ pubkey: p.address, account: { data: [p.data.subarray(0, params[1].dataSlice.length).toString('base64'), 'base64'] } }));
    }
    if (method === 'getMultipleAccounts') {
      const [keys, o] = params;
      if (o.encoding === 'jsonParsed') return { value: keys.map((k) => (c.owners.has(k) ? { owner: TOKEN_PROGRAM, data: { parsed: { info: { owner: c.owners.get(k) } } } } : null)) };
      return { value: keys.map((k) => c.accounts.get(k) || null) };
    }
    if (method === 'getTokenLargestAccounts') return { value: c.largest };
    if (method === 'getSignaturesForAddress') return (c.sigs.get(params[0]) || []).slice(0, params[1].limit);
    if (method === 'getTransaction') return c.txs.get(params[0]) || null;
    throw new Error(`unscripted ${method}`);
  };
  return c;
}
const tokAcct = (amt) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(amt), 64); return { owner: TOKEN_PROGRAM, data: [b.toString('base64'), 'base64'] }; };
function v4Pool(n, { base = MINT, quote = WSOL, live = true } = {}) {
  const d = Buffer.alloc(752); d.writeBigUInt64LE(live ? 6n : 1n, 0); d.writeBigUInt64LE(25n, 176); d.writeBigUInt64LE(10000n, 184);
  const vb = key(n * 10 + 1), vq = key(n * 10 + 2); put(d, 336, vb); put(d, 368, vq); put(d, 400, base); put(d, 432, quote);
  return { program: V4, address: key(n), data: d, vb, vq };
}
function orcaPool(n, { mintA = MINT, mintB = WSOL, liq, sqrt }) {
  const d = Buffer.alloc(653); u128(d, 49, liq); u128(d, 65, sqrt); const va = key(n * 10 + 1), vb = key(n * 10 + 2); put(d, 101, mintA); put(d, 133, va); put(d, 181, mintB); put(d, 213, vb);
  return { program: ORCA, address: key(n), data: d, va, vb };
}
const SOLP = async () => ({ price: 100 });

test('layouts: a pool that does not carry the mint the filter asked for is ignored (a changed layout fails closed)', async () => {
  const c = chain({ pools: [v4Pool(1), v4Pool(2)] });
  put(c.pools[1].data, 400, USDC); // the decoder would now read base=USDC at the offset the filter matched on MINT
  const ctx = T.makeCtx({ rpc: c.rpc, budget: 50 });
  const r = await T.discoverPools(ctx, MINT);
  assert.equal(r.pools.length, 1);
  assert.equal(r.pools[0].address, key(1));
});

test('check: constant-product pool, impact is exactly trade / quote reserve; deepest pool wins; wallets, burn and PDA holders are told apart', async () => {
  const p1 = v4Pool(1), p2 = v4Pool(2);
  const c = chain({ pools: [p1, p2], mintAuth: null, freezeAuth: null });
  // p1: 5,000 SOL against 50M tokens ($500k at $100/SOL, token $0.01); p2: 100 SOL
  c.accounts.set(p1.vb, tokAcct(50_000_000n * 10n ** 6n)); c.accounts.set(p1.vq, tokAcct(5000n * 10n ** 9n));
  c.accounts.set(p2.vb, tokAcct(1_000_000n * 10n ** 6n)); c.accounts.set(p2.vq, tokAcct(100n * 10n ** 9n));
  const ta = [key(901), key(902), key(903), key(904)];
  c.largest = [{ address: ta[0], uiAmountString: '300000000' }, { address: ta[1], uiAmountString: '200000000' }, { address: ta[2], uiAmountString: '100000000' }, { address: p1.vb, uiAmountString: '50000000' }];
  c.owners.set(ta[0], POOL_AUTH); c.owners.set(ta[1], BURN); c.owners.set(ta[2], WALLET[0]); c.owners.set(p1.vb, POOL_AUTH);
  c.supply = String(1_000_000_000n * 10n ** 6n);
  const r = await T.tokenCheck({ mint: MINT }, { rpc: c.rpc, solPrice: SOLP, ttl: 0 });
  assert.equal(r.liquidity.deepest_pool.address, key(1)); assert.equal(r.liquidity.deepest_pool.liquidity_usd, 1_000_000, '50M tokens at $0.01 + 5,000 SOL at $100');
  assert.equal(r.liquidity.deepest_pool.price_usd, 0.01);
  assert.equal(r.price_impact.buy_1000_usd.price_impact_pct, 0.2, '10 SOL into 5,000 SOL of quote reserve');
  assert.equal(r.price_impact.buy_100_usd.price_impact_pct, 0.02);
  assert.equal(r.price_impact.buy_1000_usd.mid_price_move_pct, 0.4, 'mid price moves (1+0.002)^2-1');
  assert.deepEqual(r.holders.ranked.map((h) => h.class), ['program-authority', 'burn', 'wallet', 'pool-vault']);
  assert.equal(r.holders.top1_wallet_pct, 10, 'only the wallet counts: 100M of 1B'); assert.equal(r.holders.top10_wallet_pct, 10);
  assert.equal(r.verdict, 'no_red_flags_found'); assert.equal(r.rules.find((x) => x.id === 'metadata_mutable').unknown, true, 'no metadata account -> the rule is unknown, not fired');
  assert.equal(r.rules.length, 14, 'every rule is listed whether or not it fired');
});

test('check: concentrated liquidity uses in-range virtual reserves; a DLMM pool is listed with depth but never quoted', async () => {
  // L chosen so the virtual quote reserve is 1,000 SOL: for mint as token A, B(raw) = L * sqrt(P) with sqrt = 2^64 * s
  const s = 0.00001; const sqrt = BigInt(Math.round(s * 2 ** 64));
  const L = BigInt(Math.round(1000e9 / s)); // B_raw = L*s = 1000 SOL
  const o = orcaPool(3, { liq: L, sqrt });
  const c = chain({ pools: [o] });
  c.accounts.set(o.va, tokAcct(10n ** 12n)); c.accounts.set(o.vb, tokAcct(1000n * 10n ** 9n));
  const r = await T.tokenCheck({ mint: MINT }, { rpc: c.rpc, solPrice: SOLP, ttl: 0 });
  assert.equal(r.liquidity.deepest_pool.venue, 'orca-whirlpool');
  assert.equal(r.price_impact.buy_1000_usd.price_impact_pct, 1, '10 SOL into a 1,000 SOL virtual reserve');
  assert.match(r.price_impact.basis, /concentrated liquidity in-range/);
  // price: B per A raw = s^2 ; token dec 6, SOL dec 9 -> SOL per token = s^2 * 10^(6-9)
  assert.ok(Math.abs(r.liquidity.deepest_pool.price_usd / (s * s * 1e-3 * 100) - 1) < 1e-3);
});

test('check: authorities and Token-2022 extensions fire the stated rules; the verdict is high_risk and says why', async () => {
  const c = chain({ mintAuth: WALLET[0], freezeAuth: WALLET[1], program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ext: [{ extension: 'permanentDelegate', state: { delegate: WALLET[2] } }, { extension: 'transferHook', state: { programId: WALLET[2] } }, { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 900 }, olderTransferFee: { transferFeeBasisPoints: 0 } } }, { extension: 'defaultAccountState', state: { accountState: 'frozen' } }, { extension: 'nonTransferable' }, { extension: 'tokenMetadata', state: { name: 'N', symbol: 'S', updateAuthority: WALLET[0] } }] });
  const r = await T.tokenCheck({ mint: MINT }, { rpc: c.rpc, solPrice: SOLP, ttl: 0 });
  const fired = r.rules.filter((x) => x.fired).map((x) => x.id);
  for (const id of ['mint_authority_set', 'freeze_authority_set', 'permanent_delegate', 'transfer_hook', 'non_transferable', 'default_account_state_frozen', 'transfer_fee_over_5pct', 'metadata_mutable', 'no_liquidity_found']) assert.ok(fired.includes(id), id);
  assert.ok(!fired.includes('transfer_fee_present'), 'the 5% line is exclusive: over 5% fires the critical rule, not the warning');
  assert.equal(r.verdict, 'high_risk'); assert.ok(r.critical_fired >= 6);
  assert.deepEqual(r.token2022_extensions.sort(), ['defaultAccountState', 'nonTransferable', 'permanentDelegate', 'transferFeeConfig', 'transferHook']);
  assert.equal(r.metadata.mutable, true);
  // a hook with no program, and a 3% fee, are not the critical cases
  const ev = T.evaluate({ mint_authority: null, freeze_authority: null, ext: { transferHook: { programId: null }, transferFeeConfig: { newerTransferFee: { transferFeeBasisPoints: 300 } } }, metadata: { mutable: false }, holders: { top1_wallet_pct: 1, top10_wallet_pct: 5 }, deepest: { venue: 'x', liquidity_usd: 50000 }, impact1000: { price_impact_pct: 1 }, curve_active: false });
  assert.equal(ev.verdict, 'caution'); assert.deepEqual(ev.rules.filter((x) => x.fired).map((x) => x.id), ['transfer_fee_present']);
});

test('check: pump.fun curve numbers (a real curve read on 13 Oct 2026), progress and sol to graduate', async () => {
  const d = Buffer.alloc(166);
  d.writeBigUInt64LE(730829267823851n, 8); d.writeBigUInt64LE(44045855324n, 16); d.writeBigUInt64LE(450929267823851n, 24); d.writeBigUInt64LE(14045855324n, 32); d.writeBigUInt64LE(1000000000000000n, 40); d[48] = 0;
  const enc = K.getAddressEncoder();
  const [pda] = await K.getProgramDerivedAddress({ programAddress: PUMP, seeds: ['bonding-curve', enc.encode(MINT)] });
  const c = chain({ curve: { pda, data: d } });
  const r = await T.tokenCheck({ mint: MINT }, { rpc: c.rpc, solPrice: SOLP, ttl: 0 });
  assert.equal(r.pumpfun.graduated, false); assert.equal(r.pumpfun.progress_pct, 43.14);
  assert.ok(Math.abs(r.pumpfun.sol_raised + r.pumpfun.sol_to_graduate - 85) < 0.01, 'raised plus remaining is the 85 SOL the curve graduates at, derived from the curve alone');
  assert.equal(r.rules.find((x) => x.id === 'no_liquidity_found').fired, false, 'a live curve is a market');
  assert.equal(r.price_impact.buy_1000_usd.price_impact_pct, Math.round(10e9 / 44045855324 * 1e4) / 100);
  d[48] = 1; const g = await T.tokenCheck({ mint: MINT }, { rpc: chain({ curve: { pda, data: d } }).rpc, solPrice: SOLP, ttl: 0 });
  assert.equal(g.pumpfun.graduated, true);
});

test('check: refusals and budgets', async () => {
  await assert.rejects(T.tokenCheck({}), (e) => e.kind === 'bad_request'); await assert.rejects(T.tokenCheck({ mint: 'nope' }), (e) => e.kind === 'bad_request');
  await assert.rejects(T.tokenCheck({ mint: WSOL }), (e) => e.kind === 'bad_request' && /quote asset/.test(e.message)); await assert.rejects(T.tokenCheck({ mint: USDC }), (e) => e.kind === 'bad_request');
  const c = chain(); c.accounts = new Map();
  await assert.rejects(T.tokenCheck({ mint: key(555) }, { rpc: async () => ({ value: null }), ttl: 0 }), (e) => e.kind === 'bad_request' && /no account/.test(e.message));
  await assert.rejects(T.tokenCheck({ mint: MINT }, { ctx: T.makeCtx({ rpc: chain().rpc, budget: 3 }), ttl: 0 }), (e) => e.status === 503 && /budget/.test(e.message));
  // every gPA refused -> 503; a single refused scan is a stated gap, not a failure
  const refuse = (which) => async (m, p) => { if (m === 'getProgramAccounts' && which(p)) throw new Error('solana rpc: Too many accounts requested (10000001 pubkeys)'); return chain().rpc(m, p); };
  await assert.rejects(T.tokenCheck({ mint: MINT }, { rpc: refuse(() => true), solPrice: SOLP, ttl: 0 }), (e) => e.status === 503);
  const part = await T.tokenCheck({ mint: MINT }, { rpc: refuse((p) => p[0] === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'), solPrice: SOLP, ttl: 0 });
  assert.equal(part.liquidity.scan_gaps.length, 2); assert.match(part.liquidity.scan_gaps[0], /pumpswap/);
  // 60 s cache: the second call makes no RPC calls
  const cc = chain(); await T.tokenCheck({ mint: MINT }, { rpc: cc.rpc, solPrice: SOLP, ttl: 60e3, now: 1 }); const n = cc.calls.length; await T.tokenCheck({ mint: MINT }, { rpc: cc.rpc, solPrice: SOLP, ttl: 60e3, now: 2 }); assert.equal(cc.calls.length, n);
});

test('ed25519: wallets are on the curve, PDAs are not', async () => {
  for (const w of WALLET) assert.equal(T.isOnCurve(w), true, w);
  const enc = K.getAddressEncoder();
  for (const seeds of [['bonding-curve', enc.encode(MINT)], ['x']]) { const [pda] = await K.getProgramDerivedAddress({ programAddress: PUMP, seeds }); assert.equal(T.isOnCurve(pda), false, pda); }
  assert.equal(T.isOnCurve(POOL_AUTH), false); assert.equal(T.isOnCurve('not base58 0OIl'), false); assert.equal(T.isOnCurve('1111'), false);
});

// ---- flow and clusters ----
function swapTx(sig, slot, ts, trader, tokDelta, quoteDelta, owner) {
  // the pool's vault owner moves the opposite way to the trader
  const pre = [], post = [];
  const add = (mint, o, a, b, dec) => { pre.push({ mint, owner: o, uiTokenAmount: { uiAmountString: String(a), decimals: dec } }); post.push({ mint, owner: o, uiTokenAmount: { uiAmountString: String(b), decimals: dec } }); };
  add(MINT, owner, 5000, 5000 - tokDelta, 6); add(MINT, trader, 100, 100 + tokDelta, 6); // the pool's entry first: a trader chosen without excluding pool owners would be the pool
  add(WSOL, owner, 50, 50 + quoteDelta, 9); add(WSOL, trader, 5, 5 - quoteDelta, 9);
  return { slot, blockTime: ts, transaction: { signatures: [sig], message: { accountKeys: [key(999), trader, owner] } }, meta: { err: null, preTokenBalances: pre, postTokenBalances: post, preBalances: [0, 0, 0], postBalances: [0, 0, 0] } }; // fee payer is a relayer, not the trader
}
test('flow: unique traders, top-5 share, round trips, new-wallet buyers, in a scripted market', async () => {
  const p1 = v4Pool(1); const c = chain({ pools: [p1] });
  c.accounts.set(p1.vb, tokAcct(5_000n * 10n ** 6n)); c.accounts.set(p1.vq, tokAcct(50n * 10n ** 9n));
  c.owners.set(p1.vb, POOL_AUTH); c.owners.set(p1.vq, POOL_AUTH);
  const now = Date.parse('2026-10-13T12:00:00Z'); const t = now / 1000;
  const [A, B, C] = WALLET;
  // A buys then sells (round trip, $200 + $100), B buys $50, C sells $20 ; SOL at $100
  const rows = [['s1', A, 10, 2], ['s2', A, -5, 1], ['s3', B, 4, 0.5], ['s4', C, -2, 0.2], ['s5', B, 3, 0.4], ['s6', C, -1, 0.1], ['s7', A, 1, 0.1], ['s8', B, 2, 0.2]];
  c.sigs.set(p1.vb, rows.map(([sg], i) => ({ signature: sg, err: null, slot: 100 + i, blockTime: t - 100 + i })).concat([{ signature: 'failed', err: {}, slot: 1, blockTime: t }]));
  rows.forEach(([sg, w, tok, q], i) => c.txs.set(sg, swapTx(sg, 100 + i, t - 100 + i, w, tok, q * Math.sign(tok), POOL_AUTH)));
  // wallet ages: A is old (200 txs back to a week ago), B and C are new
  c.sigs.set(A, Array.from({ length: 5 }, (_, i) => ({ signature: `a${i}`, blockTime: t - 7 * 86400 + i })).reverse());
  c.sigs.set(B, [{ signature: 'b0', blockTime: t - 3600 }]); c.sigs.set(C, [{ signature: 'c0', blockTime: t - 600 }]);
  // the unscripted mint-history call (launch bundle) returns nothing: not applicable is fine here
  const r = await T.tokenFlow({ mint: MINT, swaps: 20 }, { rpc: c.rpc, solPrice: SOLP, ttl: 0, nowMs: () => now });
  assert.equal(r.window.swaps_analyzed, 8); assert.equal(r.unique_traders, 3); assert.equal(r.unique_buyers, 2);
  assert.equal(r.buys, 5); assert.equal(r.sells, 3);
  assert.equal(r.round_trip_wallets.count, 1, 'only A both bought and sold'); assert.equal(r.round_trip_wallets.pct_of_traders, 33.33);
  assert.equal(r.volume_usd, Math.round((2 + 1 + 0.5 + 0.2 + 0.4 + 0.1 + 0.1 + 0.2) * 100));
  assert.equal(r.top5_traders_volume_share_pct, 100, 'three traders: the top five are all of them');
  assert.equal(r.top5_traders[0].wallet, A);
  assert.equal(r.new_wallet_buyers.sampled_buyers, 2); assert.equal(r.new_wallet_buyers.first_transaction_under_24h, 1, 'A is old, B is new'); assert.equal(r.new_wallet_buyers.pct, 50);
  assert.equal(r.window.transactions_unreadable, 0);
  assert.equal(r.market.venue, 'raydium-amm-v4');
});
test('flow: input rules, too few swaps, and no market are 400; a budget that runs dry is truncated, or 503 when too little was read', async () => {
  await assert.rejects(T.tokenFlow({ mint: MINT, swaps: 5 }), (e) => e.kind === 'bad_request'); await assert.rejects(T.tokenFlow({ mint: MINT, swaps: 101 }), (e) => e.kind === 'bad_request'); await assert.rejects(T.tokenFlow({ mint: WSOL }), (e) => e.kind === 'bad_request');
  await assert.rejects(T.tokenFlow({ mint: MINT }, { rpc: chain().rpc, solPrice: SOLP, ttl: 0 }), (e) => e.kind === 'bad_request' && /no pool/.test(e.message));
  const p1 = v4Pool(1); const c = chain({ pools: [p1] }); c.accounts.set(p1.vb, tokAcct(5000n * 10n ** 6n)); c.accounts.set(p1.vq, tokAcct(50n * 10n ** 9n)); c.owners.set(p1.vb, POOL_AUTH); c.owners.set(p1.vq, POOL_AUTH);
  await assert.rejects(T.tokenFlow({ mint: MINT }, { rpc: c.rpc, solPrice: SOLP, ttl: 0 }), (e) => e.kind === 'bad_request' && /fewer than 5 swaps/.test(e.message));
  c.sigs.set(p1.vb, Array.from({ length: 60 }, (_, i) => ({ signature: `x${i}`, err: null, slot: i, blockTime: 1 }))); for (let i = 0; i < 60; i++) c.txs.set(`x${i}`, swapTx(`x${i}`, i, 1, WALLET[i % 3], 1, 0.1, POOL_AUTH));
  const part = await T.tokenFlow({ mint: MINT, swaps: 50 }, { ctx: T.makeCtx({ rpc: c.rpc, budget: 40 }), solPrice: SOLP, ttl: 0 });
  assert.equal(part.truncated, true, 'a call budget that runs dry mid-read returns what was read, flagged');
  await assert.rejects(T.tokenFlow({ mint: MINT, swaps: 50 }, { ctx: T.makeCtx({ rpc: c.rpc, budget: 16 }), solPrice: SOLP, ttl: 0 }), (e) => e.status === 503);
});

test('flow: when the 20 s budget runs out the analysed swaps are returned with truncated true and the count; the cap is 100', async () => {
  const p1 = v4Pool(1); const c = chain({ pools: [p1] }); c.accounts.set(p1.vb, tokAcct(5000n * 10n ** 6n)); c.accounts.set(p1.vq, tokAcct(50n * 10n ** 9n)); c.owners.set(p1.vb, POOL_AUTH); c.owners.set(p1.vq, POOL_AUTH);
  const t = 1760000000;
  c.sigs.set(p1.vb, Array.from({ length: 90 }, (_, i) => ({ signature: `y${i}`, err: null, slot: i, blockTime: t })));
  for (let i = 0; i < 90; i++) c.txs.set(`y${i}`, swapTx(`y${i}`, i, t, WALLET[i % 3], 1, 0.1, POOL_AUTH));
  // a deadline that passes after 30 transaction reads
  let reads = 0; const ctx = T.makeCtx({ rpc: async (m, p) => { if (m === 'getTransaction' && ++reads > 30) { ctx.deadline = 0; } return c.rpc(m, p); }, budget: 400, deadline: Date.now() + 20e3 });
  const r = await T.tokenFlow({ mint: MINT, swaps: 100 }, { ctx, solPrice: SOLP, ttl: 0 });
  assert.equal(r.truncated, true); assert.equal(r.swaps_analyzed, r.window.swaps_analyzed); assert.ok(r.swaps_analyzed >= 30 && r.swaps_analyzed < 90, `analysed ${r.swaps_analyzed}`);
  assert.equal(r.window.swaps_requested, 100);
  // a full read says truncated false
  const c2 = chain({ pools: [p1] }); c2.accounts = c.accounts; c2.owners = c.owners; c2.sigs = c.sigs; c2.txs = c.txs;
  const ok = await T.tokenFlow({ mint: MINT, swaps: 50 }, { rpc: c2.rpc, solPrice: SOLP, ttl: 0 }); assert.equal(ok.truncated, false); assert.equal(ok.swaps_analyzed, 50);
  assert.equal((await T.tokenFlow({ mint: MINT }, { rpc: c2.rpc, solPrice: SOLP, ttl: 0 })).window.swaps_requested, 50, 'the default is 50');
});
test('flow: transaction reads that mostly fail are a 503 (RPC refusing), not a 400 about a quiet market', async () => {
  const p1 = v4Pool(1); const c = chain({ pools: [p1] }); c.accounts.set(p1.vb, tokAcct(5000n * 10n ** 6n)); c.accounts.set(p1.vq, tokAcct(50n * 10n ** 9n)); c.owners.set(p1.vb, POOL_AUTH); c.owners.set(p1.vq, POOL_AUTH);
  c.sigs.set(p1.vb, Array.from({ length: 40 }, (_, i) => ({ signature: `z${i}`, err: null, slot: i, blockTime: 1 })));
  const flaky = async (m, p) => { if (m === 'getTransaction') throw Object.assign(new Error('solana rpc http 500'), { status: 503 }); return c.rpc(m, p); };
  await assert.rejects(T.tokenFlow({ mint: MINT, swaps: 20 }, { rpc: flaky, solPrice: SOLP, ttl: 0 }), (e) => e.status === 503 && /rate limiting/.test(e.message));
});
test('heavy routes: at most two flow or cluster requests run at once; the third is a 503 with Retry-After, and the slot is freed after', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const a = T.heavy(() => gate); const b = T.heavy(() => gate);
  await assert.rejects(T.heavy(async () => 1), (e) => e.status === 503 && e.retryAfter === 5);
  release(); await Promise.all([a, b]);
  assert.equal(await T.heavy(async () => 7), 7);
  await assert.rejects(T.heavy(async () => { throw new Error('x'); }), /x/); assert.equal(await T.heavy(async () => 8), 8, 'a failure frees its slot too');
});

test('clusters: wallets first funded by the same account form a cluster; busy wallets are named as untraceable, not guessed', async () => {
  const c = chain(); const [A, B, C] = WALLET; const FUNDER = key(777); const OTHER = key(778);
  const ta = [key(801), key(802), key(803), key(804)];
  c.largest = [A, B, C, 'x'].map((_, i) => ({ address: ta[i], uiAmountString: String([400, 300, 200, 100][i] * 1e6) }));
  c.owners.set(ta[0], A); c.owners.set(ta[1], B); c.owners.set(ta[2], C); c.owners.set(ta[3], POOL_AUTH);
  c.supply = String(1_000_000_000n * 10n ** 6n);
  const fundTx = (sig, wallet, from) => ({ slot: 1, blockTime: 1000, transaction: { signatures: [sig], message: { accountKeys: [from, wallet] } }, meta: { err: null, preBalances: [5e9, 0], postBalances: [4.9e9, 0.1e9] } });
  c.sigs.set(A, [{ signature: 'fa', err: null }]); c.txs.set('fa', fundTx('fa', A, FUNDER));
  c.sigs.set(B, [{ signature: 'fb', err: null }]); c.txs.set('fb', fundTx('fb', B, FUNDER));
  c.sigs.set(C, [{ signature: 'fc', err: null }]); c.txs.set('fc', fundTx('fc', C, OTHER));
  const r = await T.holderClusters({ mint: MINT }, { rpc: c.rpc, solPrice: SOLP, ttl: 0 });
  assert.equal(r.holders_examined, 3); assert.equal(r.clusters.length, 1);
  assert.deepEqual([r.clusters[0].funder, r.clusters[0].holders, r.clusters[0].supply_pct], [FUNDER, 2, 70], '40% + 30% of supply');
  assert.equal(r.excluded_from_top_20[0].class, 'program-authority');
  assert.match(r.caveat, /exchange hot wallet/);
  // a wallet with 3,000 signatures cannot be traced within the budget and says so
  const many = Array.from({ length: 1000 }, (_, i) => ({ signature: `m${i}`, err: null }));
  c.sigs.set(A, many);
  const busy = await T.holderClusters({ mint: MINT }, { rpc: async (m, p) => (m === 'getSignaturesForAddress' && p[0] === A ? many : c.rpc(m, p)), solPrice: SOLP, ttl: 0 });
  assert.match(busy.holders.find((h) => h.wallet === A).funder_unknown_because, /3,000 or more/); assert.equal(busy.clusters.length, 0);
});
