// R19 (21 Oct 2026), unit level, any machine. One canonical path (lib/canon-path.js, the rules @x402/core 2.28 routes by: percent-decode each segment keeping
// %2F and %5C, collapse //, strip the trailing /, case-insensitive) is used by every place that decides "is this a priced path", and the amount an audit row
// logs comes from server-side state, never from a field of the buyer's header. test/r19-real-server.test.js shows the same defects end to end against the
// real server.js; these pin each matcher on its own, so a mutation of any one of them turns a test red.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const compat = require('../lib/compat');
const { makeKeys } = require('../lib/keys');
const { hfUsd } = require('../lib/hf');
const G = require('../tools/llm/region-gate');
const { makeRateLimiter } = require('../lib/ratelimit');
const railCtx = require('../lib/rail-ctx');
const { aliasXPayment } = require('../lib/refusals');
const { acceptedOf, settledUsd } = require('../lib/audit');
const { makeTool } = require('../lib/tool');
const T = require('../mpp/tempo');

const PRICES = {
  'GET /api/time': { usd: 0.005, tool: 'get_time' },
  'GET /api/token-risk/:mint': { usd: 0.01, tool: 'get_token_risk' },
  'GET /api/keys/buy-5': { usd: 5, tool: 'buy_key_5' },
};
const bom = (o) => Buffer.from('﻿' + JSON.stringify(o)).toString('base64');
const plain = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

test('makeGetOnly: a non-GET verb on any spelling of a priced route is the JSON 405, not a fall-through to the HTML 404', () => {
  const mw = compat.makeGetOnly({ PRICES });
  const run = (method, path) => { let out = 'next'; const res = { set() { return this; }, status(c) { out = c; return this; }, json() { return this; } }; mw({ method, path }, res, () => {}); return out; };
  for (const p of ['/api/time', '/API/TIME', '/api/time/', '/Api/Token-Risk/abc/']) { assert.equal(run('POST', p), 405, `POST ${p}`); assert.equal(run('DELETE', p), 405, `DELETE ${p}`); }
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(run(m, '/API/TIME'), 'next', m);
  assert.equal(run('POST', '/api/free'), 'next');
});

test('keys: pricedFor and purchaseGuard see the same path x402 sees (a key_hash refusal must come BEFORE anyone pays, on any spelling)', () => {
  const db = new Database(':memory:');
  const K = makeKeys({ db, PRICES, logCall: () => {}, hfUsd, paymentsOn: true });
  try {
    assert.equal(K.pricedFor('/API/TIME').tool, 'get_time');
    assert.equal(K.pricedFor('/api/time/').tool, 'get_time');
    assert.equal(K.pricedFor('/Api/Token-Risk/abc').tool, 'get_token_risk');
    assert.equal(K.pricedFor('/api/keys/buy-5'), null, 'the key routes are not metered by a key');
    assert.equal(K.pricedFor('/API/KEYS/BUY-5'), null);
    const guard = (path, query) => { let out = 'next'; const res = { status(c) { out = c; return { json() {} }; } }; K.purchaseGuard({ method: 'GET', path, query, headers: {} }, res, () => {}); return out; };
    for (const p of ['/api/keys/buy-5', '/api/keys/buy-5/', '/API/KEYS/BUY-5', '/Api/Keys/Buy-5/']) {
      assert.equal(guard(p, { key_hash: 'not-a-hash' }), 400, `bad key_hash on ${p}`);
      assert.equal(guard(p, { prefix: '!!' }), 400, `bad prefix on ${p}`);
      assert.equal(guard(p, {}), 'next', `no key_hash on ${p}`);
    }
  } finally { K.stop(); db.close(); }
});

test('region gate: a case, trailing-slash or doubled-slash spelling of a Gemini route from a blocked country is the 451, like the exact path', () => {
  const run = (path, country, method = 'GET') => { let out = 'next'; G.regionGate({ path, method, headers: { 'cf-ipcountry': country } }, { status(c) { out = c; return { json() {} }; } }, () => {}); return out; };
  for (const p of ['/api/ocr', '/API/OCR', '/Api/Ocr/', '/api//ocr', '/API/TRANSLATE', '/api/Injection-Check', '/API/OCR|eip155:8453', '/api/transcribe/']) assert.equal(run(p, 'RU'), 451, p);
  assert.equal(run('/API/OCR', 'MD'), 'next', 'an allowed country is not blocked');
  assert.equal(run('/API/PRICES', 'RU'), 'next', 'a route outside the seven is not the gate\'s business');
});

test('rate limiter: a HEAD on a free /api route, however spelled, is metered with GET (it runs the handler); a priced path however spelled is the unpaid class', () => {
  const L = makeRateLimiter({ logCall: () => {}, isPricedPath: (p) => /^\/api\/(time|token-risk\/[^/]+|keys\/buy-5)\/?$/i.test(p), presentsPayment: () => false });
  const kind = (method, path) => L.classify({ method, path, headers: {} });
  assert.equal(kind('HEAD', '/api/fear-greed'), 'metered');
  assert.equal(kind('HEAD', '/API/FEAR-GREED'), 'metered');
  assert.equal(kind('HEAD', '/api/time'), 'other', 'a HEAD on a priced route only ever gets the challenge');
  assert.equal(kind('GET', '/api/time'), 'unpaid');
  assert.equal(kind('GET', '/API/TIME/'), 'unpaid', 'a spelling of a priced route is not a free metered call');
});

test('rail context: the per-request store exists for every spelling of /api, so the payment layer sees the same request it would on the exact path', () => {
  for (const p of ['/api/time', '/API/TIME', '/Api/time/', '//api/time']) {
    let store = 'unset';
    railCtx.railContext({ path: p, headers: {} }, {}, () => { store = railCtx.als.getStore(); });
    assert.ok(store && typeof store === 'object', `store for ${p}`);
  }
  let none = 'unset';
  railCtx.railContext({ path: '/health', headers: {} }, {}, () => { none = railCtx.als.getStore(); });
  assert.equal(none, undefined, 'outside /api: no store');
});

test('R19c: the three decoders AgentFeed owns read a BOM-prefixed payment the way x402 core does (it drops the BOM)', () => {
  const pay = { x402Version: 2, accepted: { scheme: 'exact', network: 'eip155:137', amount: '2500' }, payload: {} };
  assert.deepEqual(acceptedOf(bom(pay)), pay.accepted, 'acceptedOf');
  assert.deepEqual(acceptedOf(plain(pay)), pay.accepted, 'control: without a BOM');
  assert.equal(railCtx.paidNetwork({ headers: { 'payment-signature': bom(pay) } }), 'eip155:137', 'paidNetwork');
  assert.equal(railCtx.paidNetwork({ headers: { 'payment-signature': plain(pay) } }), 'eip155:137', 'control');
  const req = { headers: { 'x-payment': bom(pay) } };
  aliasXPayment(req, { setHeader() {} }, () => {});
  assert.equal(req.headers['payment-signature'], bom(pay), 'aliasXPayment moves a BOM-prefixed v2 payload to PAYMENT-SIGNATURE');
  assert.equal(req.xPaymentNotV2, undefined);
  const junk = { headers: { 'x-payment': 'not base64 json' } };
  aliasXPayment(junk, { setHeader() {} }, () => {});
  assert.equal(junk.xPaymentNotV2, true, 'control: junk is still refused');
});

// ---- tempo (mpp/tempo.js) driven with stand-in mppx instances, as test/tempo.test.js does
const enc = (o) => 'Payment ' + Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => JSON.parse(Buffer.from(String(s).replace(/^Payment\s+/i, ''), 'base64url').toString());
const cred = () => enc({ challenge: { id: 'c', method: 'tempo', intent: 'charge', request: { currency: '0x20c0000000000000000000006a37da5c996874be' } }, payload: { type: 'transaction', signature: '0x76ab' } });
function tempoApp({ rows }) {
  const inst = (symbol, address) => ({ symbol, address, mppx: {
    charge: () => async () => ({ status: 402, challenge: { headers: new Headers({ 'WWW-Authenticate': `Payment id="x", method="tempo", intent="charge", request="${symbol}"` }) } }),
    validateCredential: async () => ({}),
    broadcastCredential: async () => ({ status: 'success', reference: '0xabc', source: 'did:pkh:eip155:4217:0xBUYER' }),
  } });
  T._setStateForTest({
    instances: [inst('OUSD', '0x20c0000000000000000000006a37da5c996874be'), inst('USDC.e', '0x20c000000000000000000000b9537d11c60e8b50')],
    routes: [[/^\/api\/thing$/, 'GET /api/thing', '0.001', '1000']],
    Credential: { deserialize: dec }, Receipt: { serialize: (r) => Buffer.from(JSON.stringify(r)).toString('base64url') },
  });
  const app = express();
  const { tool } = makeTool({ paymentsOn: true, PRICES: { 'GET /api/thing': { usd: 0.001, tool: 'get_thing' } }, decodeSettlement: () => null, logCall: (r) => rows.push(r) });
  app.use((req, _res, next) => { req.callerIp = '203.0.113.7'; next(); });
  app.use((req, res, next) => T.gate(req, res, next).catch(next));
  app.use((req, res, next) => { if (req.tempoPending) return next(); res.status(402).json({}); }); // stand-in paywall
  app.get('/api/thing', tool('get_thing', 0.001, () => ({ ok: true })));
  return app;
}
const call = async (t, app, p, headers) => { const srv = app.listen(0); t.after(() => srv.close()); const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { headers }); return r; };

test('tempo routeFor: a pull credential on a case or trailing-slash spelling of a priced route is taken by the tempo gate like on the exact path', async (t) => {
  for (const p of ['/api/thing', '/API/THING', '/api/thing/']) {
    const r = await call(t, tempoApp({ rows: [] }), p, { authorization: cred() });
    assert.equal(r.status, 200, `tempo credential on ${p}`);
    assert.ok(r.headers.get('payment-receipt'), `${p}: a receipt`);
  }
  const unpaid = await call(t, tempoApp({ rows: [] }), '/API/THING', {});
  assert.equal(unpaid.status, 402);
  assert.ok(unpaid.headers.get('www-authenticate'), 'the unpaid challenge of a spelling carries the tempo challenge too');
});

test('R19b: a tempo credential plus a decoy X-PAYMENT or PAYMENT-SIGNATURE logs the route price (the header is never read for the amount)', async (t) => {
  const decoy = plain({ x402Version: 2, accepted: { amount: '1' } });
  const rows = [];
  const app = tempoApp({ rows });
  for (const h of [{ authorization: cred() }, { authorization: cred(), 'x-payment': decoy }, { authorization: cred(), 'payment-signature': decoy }]) {
    const r = await call(t, app, '/api/thing', h);
    assert.equal(r.status, 200);
  }
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(rows.map((r) => [r.status, r.amount_usdc]), [['paid', 0.001], ['paid', 0.001], ['paid', 0.001]]);
});

// ---- the amount a paid row logs (lib/tool.js)
test('R19b: amount_usdc comes from server-side state only: the v1 requirement this server built, the requirement core matched for v2, the route price for MPP and tempo', async (t) => {
  const PR = { 'GET /api/priced': { usd: 0.01, tool: 'get_priced' } };
  const audit = [];
  const { tool } = makeTool({ paymentsOn: true, PRICES: PR, decodeSettlement: (res) => (res.req.headers['x-test-x402'] ? { payer: '0xabc', transaction: '0xtx' } : null), logCall: (r) => audit.push(r) });
  const app = express();
  app.use((req, res, next) => {
    res.req = req; req.callerIp = '203.0.113.7';
    const m = req.headers['x-test-matched']; if (m) req.x402Matched = { scheme: 'exact', amount: m };           // what the after-verify hook keeps (payments.js)
    const v1 = req.headers['x-test-v1']; if (v1) req.x402v1 = { requirements: { maxAmountRequired: v1 } };   // what lib/x402v1.js keeps
    if (req.headers['x-test-mpp']) req.mppSettlement = { payer: '0xbuyer', transaction: '0xref' };            // what mpp/index.js and mpp/tempo.js keep
    next();
  });
  app.get('/api/priced', tool('get_priced', 0.01, () => ({ ok: true })));
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  t.after(() => server.close());
  const decoy = plain({ x402Version: 2, accepted: { amount: '1' } });
  const get = (headers) => fetch(`http://127.0.0.1:${server.address().port}/api/priced`, { headers }).then((r) => r.status);
  const cases = [
    ['v2 exact', { 'x-test-x402': '1', 'x-test-matched': '10000' }, 0.01],
    ['v2 batch (half)', { 'x-test-x402': '1', 'x-test-matched': '5000' }, 0.005],
    ['v2 Gateway minimum', { 'x-test-x402': '1', 'x-test-matched': '500' }, 0.0005],
    ['v2 with a decoy header', { 'x-test-x402': '1', 'x-test-matched': '10000', 'payment-signature': decoy }, 0.01],
    ['v2 matched amount above list: not believed', { 'x-test-x402': '1', 'x-test-matched': '90000' }, 0.01],
    ['v1 requirement', { 'x-test-x402': '1', 'x-test-v1': '10000' }, 0.01],
    ['v1 requirement below list: the server-built value is the one logged', { 'x-test-x402': '1', 'x-test-v1': '5000' }, 0.005],
    ['v1 with a decoy accepted', { 'x-test-x402': '1', 'x-test-v1': '10000', 'x-payment': plain({ x402Version: 1, accepted: { amount: '1' } }) }, 0.01],
    ['x402 settled, nothing server-side known: list price', { 'x-test-x402': '1', 'payment-signature': decoy }, 0.01],
    ['x402 garbage header', { 'x-test-x402': '1', 'payment-signature': 'zzz' }, 0.01],
    ['mpp', { 'x-test-mpp': '1' }, 0.01],
    ['mpp with a decoy X-PAYMENT', { 'x-test-mpp': '1', 'x-payment': decoy }, 0.01],
    ['mpp with a decoy PAYMENT-SIGNATURE', { 'x-test-mpp': '1', 'payment-signature': decoy }, 0.01],
    ['unpaid', {}, null],
  ];
  for (const [, h] of cases) assert.equal(await get(h), 200);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(audit.length, cases.length);
  cases.forEach(([name, , want], i) => assert.equal(audit[i].amount_usdc, want, name));
  assert.equal(audit[cases.length - 1].status, 'free');
  assert.equal(settledUsd({ amount: '500' }, 0.001), 0.0005, 'settledUsd itself is unchanged: it clamps a server-side requirement');
});

test('R19b wiring: payments.js hands the resource server to rail-ctx, which keeps the requirement core matched (the source of the logged amount)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'payments.js'), 'utf8');
  assert.ok(/\bbindMatched\(resourceServer\)/.test(src), 'payments.js calls bindMatched(resourceServer)');
  assert.ok(/onBeforeVerify\(/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'rail-ctx.js'), 'utf8')), 'rail-ctx keeps it from onBeforeVerify, which runs for every payment flow');
});

// ---- the matched requirement end to end through the REAL @x402/express 2.28 (what the half-price tiers rely on)
test('R19b: through the real x402 middleware the logged amount is the requirement core matched: a payment accepted at the lower-priced offer logs that price, BOM or not', async (t) => {
  const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
  const { ExactEvmScheme } = require('@x402/evm/exact/server');
  const BASE = 'eip155:8453', POLY = 'eip155:137', PAYTO = '0x' + '22'.repeat(20), PAYER = '0x' + 'ab'.repeat(20);
  const fac = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE }, { x402Version: 2, scheme: 'exact', network: POLY }], extensions: [], signers: {} }; },
    async verify() { return { isValid: true, payer: PAYER }; },
    async settle(_p, r) { return { success: true, transaction: '0x' + '5e'.repeat(32), network: r.network, payer: PAYER }; },
  };
  const rs = new x402ResourceServer([fac]).register(BASE, new ExactEvmScheme()).register(POLY, new ExactEvmScheme());
  railCtx.bindMatched(rs);
  // the route quotes $0.01 on Base and $0.005 on Polygon: the same shape as a list price and its half-price tier
  const routes = { 'GET /api/thing': { accepts: [{ scheme: 'exact', price: '$0.01', network: BASE, payTo: PAYTO }, { scheme: 'exact', price: '$0.005', network: POLY, payTo: PAYTO }], description: 'thing', mimeType: 'application/json' } };
  const gate = paymentMiddleware(routes, rs);
  const rows = [];
  const { tool } = makeTool({ paymentsOn: true, PRICES: { 'GET /api/thing': { usd: 0.01, tool: 'get_thing' } }, decodeSettlement: (res) => { const raw = res.getHeader('payment-response'); return raw ? JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8')) : null; }, logCall: (r) => rows.push(r) });
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '203.0.113.7'; next(); });
  app.use(railCtx.railContext);
  app.use(gate);
  app.get('/api/thing', tool('get_thing', 0.01, () => ({ ok: true })));
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const challenge = await fetch(`${base}/api/thing`);
  assert.equal(challenge.status, 402);
  const pr = JSON.parse(Buffer.from(challenge.headers.get('payment-required'), 'base64').toString('utf8'));
  const pay = (accepted) => ({ x402Version: 2, resource: pr.resource, accepted, payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + String(rows.length + 1).padStart(2, '0').repeat(32) } } });
  const half = pr.accepts.find((a) => a.network === POLY), full = pr.accepts.find((a) => a.network === BASE);
  assert.equal(half.amount, '5000'); assert.equal(full.amount, '10000');
  for (const [label, header] of [['full price on Base', plain(pay(full))], ['half price on Polygon', plain(pay(half))], ['half price on Polygon, BOM-prefixed header', bom(pay(half))]]) {
    const r = await fetch(`${base}/api/thing`, { headers: { 'payment-signature': header } });
    assert.equal(r.status, 200, label);
  }
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(rows.map((r) => [r.status, r.amount_usdc]), [['paid', 0.01], ['paid', 0.005], ['paid', 0.005]], 'the matched requirement, not the list price and not a header field');
});
