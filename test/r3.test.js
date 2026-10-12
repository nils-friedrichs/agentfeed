'use strict';
// R3: honeypot simulation helpers, Base launch log parsing and V4 position math, the
// launch-odds / rwa-yields / base-launches contracts (stale = 503, untracked = 422,
// bad input = 400 before any upstream call), and the 422 emitter in lib/tool.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const V = require('viem');
const Database = require('better-sqlite3');
const express = require('express');

const tmp = (name) => path.join(os.tmpdir(), `r3-${process.pid}-${name}`);

// ---- Base launch collector: log parsing against viem's own event decoder ----
test('pool-creation logs parse to the same fields viem decodes from the raw log', () => {
  const C = require('../bin/base-launches-collect.js');
  const fx = require('./fixtures/base-pool-logs.json');
  const EVENTS = V.parseAbi([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
  ]);
  const AERO = V.parseAbi(['event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256 poolCount)']);
  assert.ok(Object.keys(fx).length >= 3, 'fixtures present');
  for (const [kind, { log }] of Object.entries(fx)) {
    const p = C.parseCreate(log);
    assert.equal(p.kind, kind);
    const ev = V.decodeEventLog({ abi: kind === 'aerodrome-v2' ? AERO : EVENTS, data: log.data, topics: log.topics });
    const a = ev.args;
    if (kind === 'uniswap-v4') {
      assert.equal(p.pool_id, a.id.toLowerCase());
      assert.equal(p.token0, a.currency0.toLowerCase()); assert.equal(p.token1, a.currency1.toLowerCase());
      assert.equal(p.fee, a.fee); assert.equal(p.tick_spacing, a.tickSpacing); assert.equal(p.hooks, a.hooks.toLowerCase());
    } else if (kind === 'uniswap-v3') {
      assert.equal(p.pool_id, a.pool.toLowerCase()); assert.equal(p.fee, a.fee); assert.equal(p.tick_spacing, a.tickSpacing);
    } else if (kind === 'uniswap-v2') {
      assert.equal(p.pool_id, a.pair.toLowerCase());
    } else {
      assert.equal(p.pool_id, a.pool.toLowerCase()); assert.equal(Boolean(p.stable), a.stable);
    }
    assert.equal(p.token0, String(a.token0 || a.currency0).toLowerCase());
  }
});

test('V4 quote side from positions: below, inside and above the current price', () => {
  const { v4QuoteAmount } = require('../bin/base-launches-collect.js');
  const sAt = (t) => Math.pow(1.0001, t / 2);
  const X96 = (s) => BigInt(Math.round(s * 2 ** 96));
  const L = 1e18;
  // quote is token1: a range wholly below the price holds only token1 = L * (sb - sa)
  const below = v4QuoteAmount([{ tl: -200, tu: -100, liq: L }], X96(sAt(0)), true);
  assert.ok(Math.abs(below - L * (sAt(-100) - sAt(-200))) / below < 1e-9);
  // a range wholly above the price holds only token0: no quote
  assert.equal(v4QuoteAmount([{ tl: 100, tu: 200, liq: L }], X96(sAt(0)), true), 0);
  // straddling: L * (s - sa)
  const inside = v4QuoteAmount([{ tl: -100, tu: 100, liq: L }], X96(sAt(0)), true);
  assert.ok(Math.abs(inside - L * (1 - sAt(-100))) / inside < 1e-6);
  // quote is token0: mirror image, and removed liquidity (sum 0) contributes nothing
  const t0 = v4QuoteAmount([{ tl: 100, tu: 200, liq: L }, { tl: -50, tu: 50, liq: 0 }], X96(sAt(0)), false);
  assert.ok(Math.abs(t0 - L * (1 / sAt(100) - 1 / sAt(200))) / t0 < 1e-9);
});

// ---- honeypot helpers ----
test('bytecode selector scan skips PUSH data and finds real PUSH4 selectors', () => {
  const H = require('../tools/honeypot');
  // PUSH32 whose data contains 63 40c10f19 (a fake PUSH4 mint), then a real PUSH4 8456cb59 (pause)
  const code = '0x7f' + '63' + '40c10f19' + '00'.repeat(27) + '63' + '8456cb59' + '14';
  const s = H._push4s(code);
  assert.ok(s.has('8456cb59'));
  assert.ok(!s.has('40c10f19'), 'bytes inside PUSH32 data are not opcodes');
});

test('revert data decodes: Error(string), Panic, OpenZeppelin balance error, unknown selector', () => {
  const H = require('../tools/honeypot');
  const err = V.encodeAbiParameters([{ type: 'string' }], ['TRANSFER_FAILED']);
  assert.equal(H._decodeRevert('0x08c379a0' + err.slice(2)).reason, 'TRANSFER_FAILED');
  assert.equal(H._decodeRevert('0x4e487b71' + V.encodeAbiParameters([{ type: 'uint256' }], [0x11n]).slice(2)).reason, 'panic 0x11');
  const ozb = V.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], ['0x000000000000000000000000000000000000a402', 5n, 2n ** 256n - 1n]);
  assert.match(H._decodeRevert('0xe450d38c' + ozb.slice(2)).reason, /ERC20InsufficientBalance: 0x0+A402 has 5, needs 1157920/i);
  assert.equal(H._decodeRevert('0xdeadbeef').reason, 'custom error 0xdeadbeef');
  assert.equal(H._decodeRevert('0x').reason, 'reverted without a reason');
});

test('verdicts: sellable, high tax, extreme tax, not sellable, buy failed, no pool', () => {
  const H = require('../tools/honeypot');
  const leg = (ok, sent, arrived, received) => ({ ok, sent, arrived, received, err: '0x', gasUsed: 1n });
  const v = (buy, sell) => H._verdictOf({ r: { buy, sell, transferOk: true } }).verdict;
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(true, 990n, 990n, 95n)), 'sellable');
  assert.equal(v(leg(true, 100n, 1000n, 880n), leg(true, 870n, 870n, 80n)), 'high_tax');   // 12% buy tax
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(true, 990n, 400n, 30n)), 'extreme_tax'); // 60% sell tax
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(true, 990n, 50n, 1n)), 'not_sellable');  // 95% sell tax
  assert.equal(v(leg(true, 100n, 1000n, 1000n), leg(false, 990n, 0n, 0n)), 'not_sellable');
  assert.equal(v(leg(false, 100n, 0n, 0n), leg(false, 0n, 0n, 0n)), 'buy_failed');
  assert.equal(H._verdictOf(null).verdict, 'no_pool_found');
});

test('honeypot-check refuses bad input before any network call', async () => {
  const H = require('../tools/honeypot');
  const realFetch = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error('no network in this test'); };
  try {
    for (const a of [{}, { token: '0x12' }, { token: '4ed4E862860beD51a9570b96d89aF5E1B0Efefed' }, { token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', chain: 'bsc' }]) {
      await assert.rejects(H.getHoneypotCheck(a), (e) => e.kind === 'bad_request');
    }
    assert.equal(calls, 0);
    // a node failure on every RPC is a 503, never a 400
    await assert.rejects(H.getHoneypotCheck({ token: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed' }), (e) => e.status === 503);
  } finally { global.fetch = realFetch; }
});

// ---- base-launches route ----
test('base-launches: fresh snapshot filters and limits; stale is 503; bad numbers are 400', () => {
  const file = tmp('bl.json');
  process.env.BASE_LAUNCHES_SNAPSHOT = file;
  delete require.cache[require.resolve('../tools/baselaunches')];
  const BL = require('../tools/baselaunches');
  const launches = [{ pool: 'a', quote_liquidity_usd: 5000 }, { pool: 'b', quote_liquidity_usd: 10 }, { pool: 'c', quote_liquidity_usd: null }];
  const now = Date.parse('2026-10-12T05:00:00Z');
  fs.writeFileSync(file, JSON.stringify({ as_of: '2026-10-12T04:58:00Z', head_block: 1, window_hours: 24, counts: {}, launches }));
  try {
    const r = BL.getBaseLaunches({}, { now });
    assert.deepStrictEqual(r.launches.map((l) => l.pool), ['a'], 'default floor $1,000');
    assert.equal(BL.getBaseLaunches({ min_liq_usd: '0', limit: '2' }, { now }).launches.length, 2);
    assert.throws(() => BL.getBaseLaunches({ limit: 0 }, { now }), (e) => e.kind === 'bad_request');
    assert.throws(() => BL.getBaseLaunches({ min_liq_usd: 'x' }, { now }), (e) => e.kind === 'bad_request');
    assert.throws(() => BL.getBaseLaunches({}, { now: now + 4 * 60000 }), (e) => e.status === 503);
  } finally { fs.unlinkSync(file); delete process.env.BASE_LAUNCHES_SNAPSHOT; }
});

// ---- rwa-yields ----
function rwaDb(file, ts) {
  const db = new Database(file);
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, key TEXT, symbol TEXT, name TEXT, issuer TEXT, category TEXT, chain TEXT, duration_days INTEGER, mint TEXT, pool TEXT, source_urls TEXT, active INTEGER, llama TEXT, verified INTEGER, unverified_reason TEXT);
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, product_id INTEGER, ts INTEGER, price REAL, nav REAL, premium_bps REAL, yield_apy REAL, tvl_usd REAL, pool_depth_usd REAL, source TEXT, flags TEXT, pool_count INTEGER, chain_breakdown TEXT);`);
  db.prepare("INSERT INTO products VALUES (1,'b','BUIDL','BlackRock fund','BlackRock','mmf','multi',30,NULL,NULL,'[]',1,NULL,1,NULL)").run();
  db.prepare("INSERT INTO products VALUES (2,'x','BENJI','Franklin fund','Franklin','mmf','multi',30,NULL,NULL,'[]',1,NULL,0,'no issuer-level entry')").run();
  const s = db.prepare('INSERT INTO snapshots (product_id, ts, yield_apy, tvl_usd, source, flags, chain_breakdown) VALUES (?,?,?,?,?,?,?)');
  s.run(1, ts - 8 * 86400, 3.5, 1000, 'defillama:x', '[]', '{"Ethereum":1000}');
  s.run(1, ts, 3.6, 1200, 'defillama:x', '["nav_unverified"]', '{"Ethereum":700,"Solana":500}');
  s.run(2, ts, null, null, 'none', '["source_unmapped"]', null);
  db.close();
}
test('rwa-yields: latest state with 7-day TVL change and honest nulls; stale is 503; bad input is 400', () => {
  const file = tmp('rwa.db');
  const now = 1791800000;
  rwaDb(file, now - 3600);
  process.env.RWAYIELD_DB = file;
  delete require.cache[require.resolve('../tools/rwayields')];
  const RW = require('../tools/rwayields');
  try {
    const r = RW.getRwaYields({}, { now });
    const b = r.products.find((p) => p.symbol === 'BUIDL');
    assert.equal(b.tvl_change_7d_usd, 200); assert.equal(b.tvl_change_7d_pct, 20);
    assert.equal(b.nav_usd, null, 'NAV unknown stays null');
    assert.deepStrictEqual(b.chains.map((c) => c.chain), ['Ethereum', 'Solana']);
    const x = r.products.find((p) => p.symbol === 'BENJI');
    assert.equal(x.verified, false); assert.equal(x.yield_apy_pct, null); assert.ok(x.unverified_reason);
    assert.equal(RW.getRwaYields({ symbol: 'buidl' }, { now }).count, 1);
    assert.throws(() => RW.getRwaYields({ symbol: 'NOPE' }, { now }), (e) => e.kind === 'bad_request' && /BUIDL/.test(e.message));
    assert.throws(() => RW.getRwaYields({ category: 'stocks' }, { now }), (e) => e.kind === 'bad_request');
    assert.throws(() => RW.getRwaYields({}, { now: now + 9 * 3600 }), (e) => e.status === 503);
  } finally { fs.unlinkSync(file); delete process.env.RWAYIELD_DB; }
});

// ---- launch-odds ----
function ledgerDb(file, lastCycle) {
  const db = new Database(file);
  db.exec(`CREATE TABLE pools (id INTEGER PRIMARY KEY, pool_address TEXT, base_mint TEXT, quote_mint TEXT, name TEXT, symbol TEXT, dex TEXT, discovered_ts INTEGER, pool_created_ts INTEGER, t0_liquidity_usd REAL, t0_volume24h_usd REAL, t0_price_usd REAL, t0_fdv_usd REAL, t0_txns24h INTEGER, t0_mint_authority TEXT, t0_freeze_authority TEXT, t0_supply REAL, cohort INTEGER, cohort_ts INTEGER, cohort_reason TEXT, retired INTEGER, t0_ts INTEGER, promo_ts INTEGER);
    CREATE TABLE checks (id INTEGER PRIMARY KEY, pool_id INTEGER, ts INTEGER, age_hours REAL, liquidity_usd REAL, volume24h_usd REAL, price_usd REAL, fdv_usd REAL, txns24h INTEGER, ok INTEGER);
    CREATE TABLE labels (id INTEGER PRIMARY KEY, pool_id INTEGER, horizon_days INTEGER, label TEXT, evidence TEXT, labeled_ts INTEGER);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);`);
  const p = db.prepare('INSERT INTO pools (id, pool_address, base_mint, dex, discovered_ts, t0_liquidity_usd, cohort, cohort_reason) VALUES (?,?,?,?,?,?,?,?)');
  const l = db.prepare('INSERT INTO labels (pool_id, horizon_days, label, evidence, labeled_ts) VALUES (?,?,?,?,?)');
  const M = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  p.run(1, 'P1', M, 'pump-fun', 1, 6000, 1, 'liquidity>=5000');
  p.run(2, 'P2', 'So11111111111111111111111111111111111111112', 'pump-fun', 1, 30000, 1, 'volume>=1000');
  p.run(3, 'P3', 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu', 'pump-fun', 1, 7000, 1, 'liquidity>=5000');
  l.run(1, 1, 'active', '{"rule":"retain>=50%"}', 2); l.run(2, 1, 'lp_removed', '{"rule":"drop>=90%"}', 2); l.run(3, 1, 'unknown', null, 2);
  db.prepare("INSERT INTO meta VALUES ('last_cycle', ?)").run(String(lastCycle));
  db.close();
}
test('launch-odds: shares over decided pools, t0 band, 422 untracked, 503 stale, 400 input', async () => {
  const file = tmp('ledger.db');
  ledgerDb(file, Math.floor(Date.now() / 1000) - 60);
  process.env.LAUNCHLEDGER_DB = file;
  delete require.cache[require.resolve('../tools/launchodds')];
  const LO = require('../tools/launchodds');
  try {
    const r = await LO.getLaunchOdds({ launchpad: 'PumpFun' });
    assert.equal(r.launchpad, 'pump-fun'); assert.equal(r.pools_followed, 3);
    const h1 = r.horizons.find((h) => h.horizon_days === 1);
    assert.equal(h1.n_decided, 2, 'unknown is excluded from the base');
    assert.equal(h1.share.active, 0.5); assert.equal(h1.share.lp_removed, 0.5); assert.equal(h1.excluded.unknown, 1);
    assert.match(r.cohort, /Only pools that crossed/);
    const band = await LO.getLaunchOdds({ launchpad: 'pump-fun', t0_liq_usd: '6500' });
    assert.deepStrictEqual([band.t0_liquidity_band.min_usd, band.t0_liquidity_band.max_usd, band.pools_followed], [5000, 10000, 2]);
    const m = await LO.getLaunchOdds({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' });
    assert.equal(m.pools[0].labels[0].label, 'active');
    await assert.rejects(LO.getLaunchOdds({ mint: '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7' }), (e) => e.status === 422 && e.code === 'not_tracked');
    await assert.rejects(LO.getLaunchOdds({ mint: "x'; DROP TABLE pools; --" }), (e) => e.kind === 'bad_request');
    await assert.rejects(LO.getLaunchOdds({}), (e) => e.kind === 'bad_request');
    await assert.rejects(LO.getLaunchOdds({ launchpad: 'nope' }), (e) => e.kind === 'bad_request' && /pump-fun \(3\)/.test(e.message));
    assert.equal(await LO.launchBlock('4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7'), null, 'token-risk: no block for an untracked mint');
  } finally { fs.unlinkSync(file); }
  // a ledger whose last cycle is two hours old answers 503
  ledgerDb(file, Math.floor(Date.now() / 1000) - 7200);
  delete require.cache[require.resolve('../tools/launchodds')];
  try {
    await assert.rejects(require('../tools/launchodds').getLaunchOdds({ launchpad: 'pump-fun' }), (e) => e.status === 503);
  } finally { fs.unlinkSync(file); delete process.env.LAUNCHLEDGER_DB; }
});

// ---- lib/tool.js: the 422 emitter ----
test('a 422-marked throw is a JSON 422 with its code, logged as bad_request', async (t) => {
  const { makeTool } = require('../lib/tool');
  const logged = [];
  const { tool } = makeTool({ paymentsOn: false, PRICES: {}, decodeSettlement: () => null, logCall: (r) => logged.push(r) });
  const app = express();
  app.get('/x', tool('get_x', 0.01, () => { throw Object.assign(new Error('not_tracked: nope'), { status: 422, kind: 'bad_request', code: 'not_tracked' }); }));
  const srv = app.listen(0); t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/x`);
  assert.equal(r.status, 422);
  assert.deepStrictEqual(await r.json(), { tool: 'get_x', error: 'not_tracked: nope', code: 'not_tracked' });
  assert.equal(logged[0].status, 'bad_request');
});
