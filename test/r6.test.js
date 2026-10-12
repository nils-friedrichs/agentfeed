// test/r6.test.js — R6 (13 Oct 2026): D1 unsupported symbol is a 400, D2 no OKX/Binance reads,
// D3 the peg reference is not returned, D4 wallet-holdings carries no Helius prices.
//
// Everything is offline: the venues are a local stub that answers 404 to every request, the
// liquidation tape is a scratch SQLite file, Solana RPC points at a closed port, and the
// wallet test stubs fetch for the one Helius call and injects the SOL price.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-r6-'));
let server, EN, L, P, OCH, PR;

const tapeRow = (db, symbol, ts) => db.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?,?,?,?,?,?,?)').run(ts, symbol, 'Buy', 1, 100, 100, 'bybit');

test.before(async () => {
  // every venue answers 404: "could not be asked" for every symbol
  server = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"stub"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.BYBIT_REST = `${base}/bybit`;
  process.env.HL_API = `${base}/hl/info`;
  process.env.SOLANA_RPC_URL = 'http://127.0.0.1:9'; // closed port: the SOL pools fail at once
  const db = new Database(path.join(tmp, 'liq.db'));
  db.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL,
           side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit')`);
  tapeRow(db, 'ZQQ8USDT', Date.now() - 3 * 86_400_000); // recorded before, but nothing in the last 24h
  db.close();
  process.env.LIQ_DB = path.join(tmp, 'liq.db'); // read at require time by entry.js and liqdb.js

  // the pegwatch history for D3: a live-looking symbol (distinct prices) with an Alpaca-style reference of 99.5
  const pdb = new Database(path.join(tmp, 'pegwatch.db'));
  pdb.exec('CREATE TABLE ticks (ts INTEGER, symbol TEXT, onchain REAL, ref REAL, ref_source TEXT, session TEXT, dev_bps REAL, liq_usd REAL, dex TEXT, pool TEXT)');
  const ins = pdb.prepare('INSERT INTO ticks VALUES (?,?,?,?,?,?,?,?,?,?)');
  const t0 = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 40; i++) ins.run(t0 - 60 * (40 - i), 'TSLAx', 100 + i * 0.01, 99.5, 'alpaca', 'open', 50 + i, 500000, 'orca', 'POOL');
  pdb.close();
  process.env.PEGWATCH_DB = path.join(tmp, 'pegwatch.db');
  process.env.PEG_ONCHAIN_DB = path.join(tmp, 'peg-onchain.db');

  EN = require('../tools/entry');
  L = require('../tools/liqdb');
  P = require('../tools/peg');
  OCH = require('../tools/pegonchain');
  PR = require('../tools/prices');
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- D1: the route wrapper ----------------------------------------------------------
test('D1 wrapper: a thrown error that carries `supported` answers 400 with it, and the audit row is bad_request, never paid', async () => {
  const { makeTool } = require('../lib/tool');
  const audit = [];
  const { tool } = makeTool({ paymentsOn: true, PRICES: { 'GET /api/x': { usd: 0.005 } }, decodeSettlement: () => ({ payer: 'P', transaction: 'T' }), logCall: (r) => audit.push(r) });
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.9'; next(); });
  app.get('/api/x', tool('get_x', 0.005, () => { throw Object.assign(new Error('unsupported symbol "Q"'), { kind: 'bad_request', supported: ['SOL', 'BTC'] }); }));
  app.get('/api/y', tool('get_y', 0.005, () => { throw Object.assign(new Error('missing x'), { kind: 'bad_request' }); }));
  const s = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  try {
    const a = await fetch(`http://127.0.0.1:${s.address().port}/api/x`);
    assert.equal(a.status, 400);
    assert.deepEqual(await a.json(), { tool: 'get_x', error: 'unsupported symbol "Q"', supported: ['SOL', 'BTC'] });
    const b = await fetch(`http://127.0.0.1:${s.address().port}/api/y`);
    assert.equal(b.status, 400);
    assert.deepEqual(await b.json(), { tool: 'get_y', error: 'missing x' }, 'no `supported` key when the error carries none');
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(audit.map((r) => r.status), ['bad_request', 'bad_request']);
    assert.ok(audit.every((r) => r.status !== 'paid' && r.tx_sig === undefined && r.amount_usdc === undefined), 'a 400 leaves no paid row (negative control: the stub settlement decoder would have produced one on a 200)');
  } finally { s.close(); }
});

// ---- D1: /api/price ------------------------------------------------------------------
test('D1 /api/price: an unsupported symbol throws bad_request with the supported list (so 400, unbilled)', async () => {
  for (const sym of ['DOGE', 'dogeusdt', 'not-a-symbol']) {
    await assert.rejects(EN.getSpot({ symbol: sym }), (e) => {
      assert.equal(e.kind, 'bad_request');
      assert.deepEqual(e.supported, PR.SYMBOLS);
      assert.deepEqual(e.supported, ['SOL', 'BTC', 'ETH']);
      assert.match(e.message, /unsupported symbol/);
      assert.ok(e.message.includes('SOL, BTC, ETH'));
      return true;
    }, sym);
  }
});

test('D1 /api/price: a supported symbol is never rejected as unsupported (negative control: it fails later, as an outage)', async () => {
  for (const sym of ['SOL', 'solusdt']) {
    await assert.rejects(EN.getSpot({ symbol: sym }), (e) => {
      assert.notEqual(e.kind, 'bad_request', 'passed the symbol gate');
      assert.equal(e.status, 503, 'closed RPC port: every pool failed, a 503, not billed');
      return true;
    }, sym);
  }
});

// ---- D1: /api/perp -------------------------------------------------------------------
test('D1 /api/perp: a symbol no venue lists and the tape never recorded is a 400 with examples', async () => {
  await assert.rejects(EN.getPerp({ symbol: 'ZQQ9USDT' }), (e) => {
    assert.equal(e.kind, 'bad_request');
    assert.deepEqual(e.supported, ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT']);
    assert.match(e.message, /unsupported symbol "ZQQ9USDT"/);
    return true;
  });
});

test('D1 /api/perp: a symbol the tape recorded before still declines with 200 when no venue answers (the decline is the product)', async () => {
  const r = await EN.getPerp({ symbol: 'ZQQ8USDT' });
  assert.equal(r.symbol, 'ZQQ8USDT');
  assert.match(r.decline, /no venue served ZQQ8USDT/);
  assert.deepEqual(r.tried, ['bybit', 'hyperliquid'], 'two venues, no OKX');
});

// ---- D1: /api/squeeze-score ----------------------------------------------------------
test('D1 /api/squeeze-score: an unknown symbol is a 400; a known one whose inputs did not resolve declines with 200', async () => {
  await assert.rejects(L.getSqueezeScore({ symbol: 'ZQQ9USDT' }), (e) => {
    assert.equal(e.kind, 'bad_request');
    assert.deepEqual(e.supported, ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT']);
    assert.match(e.message, /nothing to score/);
    return true;
  });
  const r = await L.getSqueezeScore({ symbol: 'ZQQ8USDT' });
  assert.equal(r.decline, 'insufficient_inputs');
  assert.equal(r.recorded_in_tape, true);
  assert.deepEqual(r.missing_inputs, ['funding_rate_8h', 'oi_change_24h_pct', 'long_account_pct']);
});

// ---- D2: no module reads OKX or Binance market data -----------------------------------
test('D2 guard: nothing under tools/ or bin/ calls an OKX or Binance endpoint', () => {
  const root = path.join(__dirname, '..');
  const files = [...fs.readdirSync(path.join(root, 'tools')).map((f) => path.join('tools', f)), ...fs.readdirSync(path.join(root, 'bin')).map((f) => path.join('bin', f))]
    .filter((f) => /\.(js|mjs)$/.test(f));
  assert.ok(files.length > 20, 'the scan saw the source files');
  const hits = files.filter((f) => /okx\.com|binance\.com|OKX_REST/i.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(hits, [], 'banned venues are not read');
  // negative control: the pattern does find a real hit
  assert.ok(/okx\.com|binance\.com|OKX_REST/i.test("fetch('https://www.okx.com/api/v5/x')"));
});

// ---- D3: peg-deviation ----------------------------------------------------------------
test('D3 peg-deviation: latest.reference is null and the reference price appears nowhere in the answer', () => {
  const ts = Math.floor(Date.now() / 1000);
  OCH.latest = () => ({ ts, session: 'open', onchain: 100.4, ref: 99.5, dev_bps: 90.5, liq_usd: 500000, dex: 'orca', pool: 'POOL' });
  OCH.cutover = () => null;
  const r = P.getPegDeviation({ symbol: 'TSLA', hours: 24 });
  assert.equal(r.status, 'ok');
  assert.equal(r.latest.reference, null);
  assert.equal(r.latest.deviation_bps, 90.5, 'the deviation computed from the reference is still served');
  assert.equal(r.latest.onchain, 100.4);
  assert.ok(!JSON.stringify(r).includes('99.5'), 'negative control: the stubbed reference value 99.5 does not leak anywhere');
  assert.match(r.note, /reference price itself is not returned/);
});

// ---- D4: wallet-holdings --------------------------------------------------------------
test('D4 wallet-holdings: no Helius prices; native SOL valued at OUR price and labelled', async () => {
  const { getWalletHoldings } = require('../tools/onchain');
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ result: {
    total: 3,
    nativeBalance: { lamports: 2_500_000_000, price_per_sol: 777, total_price: 1942.5 },
    items: [
      { id: 'MINT1', interface: 'FungibleToken', token_info: { symbol: 'AAA', balance: 5_000_000, decimals: 6, price_info: { price_per_token: 1234.5, total_price: 6172.5 } } },
      { id: 'NFT1', interface: 'V1_NFT' },
    ] } }) });
  try {
    const r = await getWalletHoldings('4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', { priceFn: async (s) => { assert.equal(s, 'SOL'); return { price: 100, source: 'on-chain DEX mid, test pools' }; } });
    assert.equal(r.native_sol, 2.5);
    assert.equal(r.native_sol_usd, 250, 'our price x balance, not the 1942.5 Helius sent');
    assert.match(r.native_sol_usd_source, /AgentFeed's own price: on-chain DEX mid, test pools/);
    assert.deepEqual(r.fungible_tokens, [{ mint: 'MINT1', symbol: 'AAA', amount: 5 }], 'balances and metadata only');
    assert.equal(r.nft_count, 1);
    const s = JSON.stringify(r);
    for (const leaked of ['1234.5', '6172.5', '1942.5', '777', 'price_usd', 'value_usd']) assert.ok(!s.includes(leaked), `no Helius price field or value: ${leaked}`);
    // the SOL price cannot be read: balances still come back, the value is null with the reason
    const down = await getWalletHoldings('4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7', { priceFn: async () => { throw new Error('boom'); } });
    assert.equal(down.native_sol, 2.5);
    assert.equal(down.native_sol_usd, null);
    assert.match(down.native_sol_usd_source, /unavailable/);
    assert.equal(down.fungible_tokens.length, 1);
  } finally { global.fetch = realFetch; }
});
