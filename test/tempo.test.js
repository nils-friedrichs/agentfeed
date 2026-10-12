'use strict';
// mpp/tempo.js gate against stand-in mppx instances: a pull credential is validated, the
// response held, and broadcast ONLY when the handler answers < 400; push is refused; a failed
// broadcast answers 402 and withholds the data; unpaid 402s carry the tempo challenge.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const T = require('../mpp/tempo');

const enc = (o) => 'Payment ' + Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => JSON.parse(Buffer.from(String(s).replace(/^Payment\s+/i, ''), 'base64url').toString());
function boot({ status = 200, broadcast = async () => ({ status: 'success', reference: '0xabc', source: 'did:pkh:eip155:4217:0xBUYER' }), validate = async () => ({}) } = {}) {
  const calls = { validate: 0, broadcast: 0 };
  const inst = (symbol, address) => ({ symbol, address, mppx: {
    charge: () => async () => ({ status: 402, challenge: { headers: new Headers({ 'WWW-Authenticate': `Payment id="x", method="tempo", intent="charge", request="${symbol}"` }) } }),
    validateCredential: async (...a) => { calls.validate++; return validate(...a); },
    broadcastCredential: async (...a) => { calls.broadcast++; return broadcast(...a); },
  } });
  T._setStateForTest({
    instances: [inst('OUSD', '0x20c0000000000000000000006a37da5c996874be'), inst('USDC.e', '0x20c000000000000000000000b9537d11c60e8b50')],
    routes: [[/^\/api\/thing$/, 'GET /api/thing', '0.001', '1000']],
    Credential: { deserialize: dec }, Receipt: { serialize: (r) => Buffer.from(JSON.stringify(r)).toString('base64url') },
  });
  const app = express();
  app.use((req, res, next) => T.gate(req, res, next).catch(next));
  app.use((req, res, next) => { if (req.tempoPending) return next(); res.status(402).json({}); }); // stand-in paywall
  app.get('/api/thing', (req, res) => res.status(status).json({ ok: status < 400, settled: req.mppSettlement || null }));
  return { app, calls };
}
async function call(t, app, headers = {}) {
  const srv = app.listen(0); t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/thing`, { headers });
  return { r, body: await r.json().catch(() => null) };
}
const cred = (type) => enc({ challenge: { id: 'c', method: 'tempo', intent: 'charge', request: { currency: '0x20c0000000000000000000006a37da5c996874be' } }, payload: type === 'hash' ? { type, hash: '0x11' } : { type, signature: '0x76ab' } });

test('unpaid 402 carries both tempo challenges in WWW-Authenticate, OUSD first', async (t) => {
  const { r } = await call(t, boot().app);
  assert.equal(r.status, 402);
  const wa = r.headers.get('www-authenticate');
  assert.ok(wa.indexOf('request="OUSD"') >= 0 && wa.indexOf('request="OUSD"') < wa.indexOf('request="USDC.e"'), wa);
});

test('pull credential: validated, handler 200, broadcast once, receipt, settlement for the audit row', async (t) => {
  const { app, calls } = boot();
  const { r, body } = await call(t, app, { authorization: cred('transaction') });
  assert.equal(r.status, 200);
  assert.equal(calls.validate, 1); assert.equal(calls.broadcast, 1);
  assert.ok(r.headers.get('payment-receipt'));
  assert.equal(body.ok, true);
});

test('pull credential: handler 500 is sent and NEVER broadcast', async (t) => {
  const { app, calls } = boot({ status: 500 });
  const { r } = await call(t, app, { authorization: cred('transaction') });
  assert.equal(r.status, 500);
  assert.equal(calls.validate, 1); assert.equal(calls.broadcast, 0);
  assert.equal(r.headers.get('payment-receipt'), null);
});

test('pull credential: handler 400 never broadcast either', async (t) => {
  const { app, calls } = boot({ status: 400 });
  assert.equal((await call(t, app, { authorization: cred('transaction') })).r.status, 400);
  assert.equal(calls.broadcast, 0);
});

test('push (hash) credential is refused before validation; nothing broadcast', async (t) => {
  const { app, calls } = boot();
  const { r, body } = await call(t, app, { authorization: cred('hash') });
  assert.equal(r.status, 402);
  assert.match(body.detail, /hash credentials are not accepted/);
  assert.equal(calls.validate, 0); assert.equal(calls.broadcast, 0);
  assert.ok(r.headers.get('www-authenticate'), 'a fresh challenge comes back');
});

test('a failed broadcast answers 402 and withholds the data', async (t) => {
  const { app } = boot({ broadcast: async () => { throw Object.assign(new Error('insufficient balance'), { name: 'VerificationFailedError' }); } });
  const { r, body } = await call(t, app, { authorization: cred('transaction') });
  assert.equal(r.status, 402);
  assert.match(body.detail, /tempo settlement refused: insufficient balance/);
  assert.equal(body.ok, undefined);
});

test('a refused validation answers 402 with the reason', async (t) => {
  const { app, calls } = boot({ validate: async () => { throw Object.assign(new Error('credential scope does not match'), { name: 'InvalidChallengeError' }); } });
  const { r, body } = await call(t, app, { authorization: cred('transaction') });
  assert.equal(r.status, 402); assert.match(body.type, /invalid-challenge$/); assert.equal(calls.broadcast, 0);
});

test('token amounts: mppx takes token units, the challenge carries base units', () => {
  assert.equal(T._tokenAmount(0.001), '0.001'); assert.equal(T._tokenAmount(0.1), '0.1'); assert.equal(T._usdToUnits(0.005), '5000');
});
