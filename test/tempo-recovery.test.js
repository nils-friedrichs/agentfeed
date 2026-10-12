'use strict';
// mpp/tempo.js broadcast-error recovery (12 Oct 2026): a broadcast that errors on transport is
// not refused until the signed transaction's receipt has been looked for. Stand-in mppx
// instances and a stand-in RPC; the decoder and matcher are checked against the real modules
// and the real transactions of 12 Oct at the end.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const T = require('../mpp/tempo');
const { makeRefusalRecorder } = require('../lib/refusals');

const OUSD = '0x20c0000000000000000000006a37da5c996874be';
const PAYTO = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const PAYER = '0x05b38ff795a2d750788157f1119e5d403d8ef47a';
const HASH = '0x' + 'ab'.repeat(32);
const enc = (o) => 'Payment ' + Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => JSON.parse(Buffer.from(String(s).replace(/^Payment\s+/i, ''), 'base64url').toString());
const cred = () => enc({ challenge: { id: 'chal-1', realm: 'x402.ochinimus.app', method: 'tempo', intent: 'charge', request: { currency: OUSD } }, payload: { type: 'transaction', signature: '0x76abcd' } });
class PaymentError extends Error {}
const http502 = () => Object.assign(new Error('HTTP request failed.\n\nStatus: 502'), { name: 'HttpRequestError' });

function memStore() {
  const m = new Map();
  return { m, tryClaim: async (store, key) => { if (m.has(key)) return false; m.set(key, 1); return true; } };
}

// receiptAt: how many polls return null before the receipt appears (Infinity = never)
function boot({ broadcast = async () => { throw http502(); }, receipt = { status: '0x1', transactionHash: HASH, logs: [] },
  receiptAt = 0, match = () => null, store = memStore(), recovery = { pollMs: 20, windowMs: 600, resendAfterMs: 100 } } = {}) {
  const calls = { broadcast: 0, receipts: 0, sends: 0, rows: [] };
  const inst = (symbol, address) => ({ symbol, address, mppx: {
    charge: () => async () => ({ status: 402, challenge: { headers: new Headers({ 'WWW-Authenticate': `Payment id="x", method="tempo", intent="charge", request="${symbol}"` }) } }),
    validateCredential: async () => ({}),
    broadcastCredential: async (...a) => { calls.broadcast++; return broadcast(...a); },
  } });
  T._setStateForTest({
    instances: [inst('OUSD', OUSD), inst('USDC.e', '0x20c000000000000000000000b9537d11c60e8b50')],
    routes: [[/^\/api\/thing$/, 'GET /api/thing', '0.001', '1000']],
    Credential: { deserialize: dec }, Receipt: { serialize: (r) => Buffer.from(JSON.stringify(r)).toString('base64url') },
    realm: 'x402.ochinimus.app', recipient: PAYTO, PaymentError,
    settled: {}, tryClaim: store.tryClaim,
    decode: async () => ({ from: PAYER, hash: HASH, canonical: '0x76abcd', validBefore: null }),
    matchTransfer: (r, x) => { calls.expect = x; return match(r, x); },
    rpc: async (url, method) => {
      if (method === 'eth_sendRawTransaction') { calls.sends++; return { result: HASH }; }
      calls.receipts++;
      return { result: calls.receipts > receiptAt ? receipt : null };
    },
    recovery,
  });
  const app = express();
  const PRICES = { 'GET /api/thing': { usd: 0.001, tool: 'get_thing' } };
  app.use(makeRefusalRecorder({ logCall: (row) => calls.rows.push(row), PRICES }));
  app.use((req, res, next) => T.gate(req, res, next).catch(next));
  app.use((req, res, next) => { if (req.tempoPending) return next(); res.status(402).json({}); });
  // the settlement exists once the held response is released, as lib/tool.js reads it on 'finish'
  app.get('/api/thing', (req, res) => { res.on('finish', () => { calls.settled = req.mppSettlement || null; }); res.json({ ok: true }); });
  return { app, calls, store };
}
async function call(t, app) {
  const srv = app.listen(0); t.after(() => srv.close());
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/thing`, { headers: { authorization: cred() } });
  const body = await r.json().catch(() => null);
  await new Promise((res) => setTimeout(res, 20)); // let the refusal row's 'finish' run
  return { r, body, ms: Date.now() - t0 };
}

test('broadcast 502, matching receipt: 200, data, Payment-Receipt with the hash, settled for the paid row', async (t) => {
  const { app, calls } = boot();
  const { r, body } = await call(t, app);
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  const rc = JSON.parse(Buffer.from(r.headers.get('payment-receipt'), 'base64url').toString());
  assert.deepEqual([rc.method, rc.status, rc.reference], ['tempo', 'success', HASH]);
  assert.ok(rc.timestamp);
  assert.deepEqual(calls.settled, { payer: PAYER, transaction: HASH, method: 'tempo', token: 'OUSD' });
  assert.deepEqual(calls.expect, { hash: HASH, from: PAYER, currency: OUSD, recipient: PAYTO, units: '1000', realm: 'x402.ochinimus.app', challengeId: 'chal-1' });
  assert.equal(calls.rows.length, 0, 'no refusal row');
});

test('receipt that does not match (failed status, wrong to/amount/token): 402, data withheld, hash logged', async (t) => {
  const { app, calls } = boot({ match: () => 'it carries no matching transfer' });
  const { r, body } = await call(t, app);
  assert.equal(r.status, 402);
  assert.equal(body.ok, undefined, 'no data');
  assert.match(body.detail, /the transaction landed but it carries no matching transfer/);
  assert.equal(r.headers.get('payment-receipt'), null);
  assert.equal(calls.rows[0].status, 'payment_refused');
  assert.equal(calls.rows[0].tx_sig, HASH);
  assert.equal(calls.rows[0].payer_wallet, PAYER);
});

test('no receipt ever: 402 inside the window, the raw tx re-sent once, hash in tx_sig', async (t) => {
  const { app, calls } = boot({ receiptAt: Infinity });
  const { r, body, ms } = await call(t, app);
  assert.equal(r.status, 402);
  assert.match(body.detail, /no receipt for 0xab.* within/);
  assert.ok(ms < 600 + 1500, `refused in ${ms} ms`);
  assert.equal(calls.sends, 1, 'one plain eth_sendRawTransaction');
  assert.equal(calls.rows[0].tx_sig, HASH);
});

test('the production window is 15 s, polling every 500 ms, re-send after 3 s, on two RPCs', () => {
  assert.deepEqual(T.RECOVERY, { pollMs: 500, windowMs: 15000, resendAfterMs: 3000 });
  assert.deepEqual(T.RECEIPT_RPCS, ['https://rpc.tempo.xyz', 'https://rpc.mainnet.tempo.xyz']);
});

test('receipt appears after the re-send: settled', async (t) => {
  const { app, calls } = boot({ receiptAt: 8 });
  const { r } = await call(t, app);
  assert.equal(r.status, 200);
  assert.equal(calls.sends, 1);
});

test('replay of a credential settled through the recovery is refused', async (t) => {
  const store = memStore();
  const a = boot({ store });
  assert.equal((await call(t, a.app)).r.status, 200);
  // same process: mppx's own claim makes the broadcast throw its PaymentError; no recovery
  const b = boot({ store, broadcast: async () => { throw new PaymentError('Transaction hash has already been used'); } });
  const rb = await call(t, b.app);
  assert.equal(rb.r.status, 402);
  assert.match(rb.body.detail, /already been used/);
  assert.equal(b.calls.receipts, 0, 'a payment error is never recovered');
  // after a restart (mppx's memory store forgot): transport error, receipt found, durable claim lost
  const c = boot({ store });
  const rc = await call(t, c.app);
  assert.equal(rc.r.status, 402);
  assert.match(rc.body.detail, /already settled \(replay\)/);
});

test('happy path: broadcast resolves, no receipt polling, settled and claimed', async (t) => {
  const store = memStore();
  const { app, calls } = boot({ store, broadcast: async () => ({ method: 'tempo', status: 'success', reference: HASH }) });
  const { r } = await call(t, app);
  assert.equal(r.status, 200);
  assert.equal(calls.receipts, 0); assert.equal(calls.sends, 0);
  assert.equal(calls.settled.payer, PAYER, 'payer from the signed transaction');
  assert.equal(calls.settled.transaction, HASH);
  assert.ok(store.m.has(HASH), 'the hash is claimed on the normal path too');
});

// ---- the real decoder and matcher, on the real transactions of 12 Oct 2026 ----
const RAW_F20A = require('./fixtures/tempo-f20a-raw.json');

test('real decoder: signer and canonical hash of a mainnet tempo transaction', async () => {
  const { keccak256, Transaction } = await T._loadDeps();
  const d = await T._makeDecoder(Transaction, keccak256)(RAW_F20A.raw);
  assert.equal(d.hash, '0xf20a97447c8f54f990020b0276d8f6539835861e0bd4cd30ea32e1cad77dc0c8');
  assert.equal(d.from, PAYER);
  assert.equal(d.validBefore, 1791824635);
});

test('real matcher: only the exact challenge-bound TransferWithMemo matches', async () => {
  const { parseEventLogs, Abis, Attribution: A } = await T._loadDeps();
  const { encodeEventTopics, encodeAbiParameters } = await import('viem');
  const match = T._makeMatcher(parseEventLogs, Abis, A);
  const memo = A.encode({ challengeId: 'chal-1', serverId: 'x402.ochinimus.app' });
  const log = (o = {}) => ({ address: o.token || OUSD, topics: encodeEventTopics({ abi: Abis.tip20, eventName: 'TransferWithMemo', args: { from: PAYER, to: o.to || PAYTO, memo: o.memo || memo } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [o.amount ?? 1000n]), blockNumber: '0x1', transactionHash: HASH, logIndex: '0x0', blockHash: '0x' + '00'.repeat(32), transactionIndex: '0x0', removed: false });
  const x = { hash: HASH, from: PAYER, currency: OUSD, recipient: PAYTO, units: '1000', realm: 'x402.ochinimus.app', challengeId: 'chal-1' };
  const rc = (logs, status = '0x1') => ({ status, transactionHash: HASH, logs });
  assert.equal(match(rc([log()]), x), null);
  assert.match(match(rc([log()], '0x0'), x), /status is not success/);
  assert.match(match(rc([log({ amount: 999n })]), x), /no matching transfer/);
  assert.match(match(rc([log({ to: '0x' + '11'.repeat(20) })]), x), /no matching transfer/);
  assert.match(match(rc([log({ token: '0x20c000000000000000000000b9537d11c60e8b50' })]), x), /no matching transfer/);
  assert.match(match(rc([log({ memo: A.encode({ challengeId: 'other', serverId: 'x402.ochinimus.app' }) })]), x), /no matching transfer/);
  assert.match(match({ ...rc([log()]), transactionHash: '0x' + 'cd'.repeat(32) }, x), /another transaction/);
});
