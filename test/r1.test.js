'use strict';
// R1: MPP credential shape, x402 sent in the MPP header, the honest refusal on x402-only
// routes, and demand telemetry. All values are synthetic; nothing reaches a facilitator.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const Database = require('better-sqlite3');
const { makeRefusalRecorder, sanitizeChallengeErrors, aliasXPayment, aliasAuthorizationPayment, makeMppOnX402Only, MPP_ON_X402_ONLY, _mppShape } = require('../lib/refusals');
const { makeDemand } = require('../lib/demand');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString());
const PRICES = { 'GET /api/positioning': { tool: 'get_positioning', usd: 0.005 }, 'GET /api/sol-price': { tool: 'get_sol_price', usd: 0.005 } };
const V2 = { x402Version: 2, accepted: { scheme: 'exact', network: 'solana:x' }, payload: { transaction: 'AA' } };
const MPP_CRED = b64url({ challenge: { id: 'c1', realm: 'r', method: 'solana', intent: 'charge' }, payload: { type: 'transaction', transaction: 'AA' } });

function boot() {
  const rows = [];
  const db = new Database(':memory:');
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '198.51.100.9'; next(); });
  app.use(makeRefusalRecorder({ logCall: (r) => rows.push(r), PRICES, mppPayer: () => null }));
  app.use(makeDemand({ db, logCall: (r) => rows.push(r), PRICES }));
  app.use(aliasAuthorizationPayment);
  app.use(sanitizeChallengeErrors);
  app.use(aliasXPayment);
  app.use(makeMppOnX402Only({ mppPaths: () => ['/api/sol-price'] }));
  // stand-in MPP gate on sol-price: any Payment credential is MPP's to refuse
  app.get('/api/sol-price', (req, res, next) => {
    if (/^payment\s/i.test(req.headers.authorization || '')) return res.status(402).type('application/problem+json').send(JSON.stringify({ type: 'x/malformed-credential', title: 'Malformed Credential', detail: 'mpp saw it' }));
    next();
  });
  // stand-in x402 layer: a v2 PAYMENT-SIGNATURE "settles"; anything else gets the plain challenge
  app.use((req, res, next) => {
    if (!PRICES['GET ' + req.path]) return next();
    const ps = req.headers['payment-signature'];
    if (ps && unb64(ps).x402Version === 2) { res.setHeader('PAYMENT-RESPONSE', b64({ success: true, payer: 'BUYER', transaction: 'T' })); return next(); }
    res.setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, error: 'Payment required', accepts: [] }));
    res.status(402).json({});
  });
  app.get('/api/positioning', (_req, res) => res.json({ ok: 1 }));
  app.get('/api/sol-price', (_req, res) => res.json({ ok: 1 }));
  app.get('/api/sample/:r', (_req, res) => res.status(404).json({ error: 'no such paid route' }));
  return { app, rows, db };
}
async function call(t, ctx, path, headers = {}) {
  const srv = ctx.app.listen(0); t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { headers });
  await r.text();
  await new Promise((ok) => setTimeout(ok, 20)); // 'finish' handlers
  return r;
}
const refused = (rows) => rows.filter((r) => r.status === 'payment_refused');

test('mpp shape: classes, both decodings, version, dots, params; never the value', () => {
  const sh = (h) => _mppShape({ headers: h });
  const s1 = sh({ authorization: `Payment ${b64(V2)}` });
  assert.match(s1, /^Authorization scheme=Payment len=\d+ prefix=\S{8} base64urljson=(yes|no) base64json=yes x402Version=2 dots=0 params=no$/);
  assert.match(sh({ 'payment-authorization': `Payment ${MPP_CRED}` }), /^Payment-Authorization scheme=Payment .* base64urljson=yes .* dots=0 params=no$/);
  assert.match(sh({ authorization: 'Payment aaa.bbb.ccc' }), /dots=2 params=no/);
  assert.match(sh({ authorization: 'Payment id="x", realm="y"' }), /base64urljson=no base64json=no dots=0 params=yes/);
  assert.match(sh({ authorization: 'Payment !!!%%' }), /prefix=\?\?\?\?\? base64urljson=no base64json=no/);
  assert.equal(sh({ authorization: 'Bearer abc' }), null);
  assert.ok(!s1.includes(b64(V2).slice(0, 20)), 'credential text never stored');
});

test('x402 v2 in Authorization on an x402-only route settles as x402', async (t) => {
  const ctx = boot();
  const r = await call(t, ctx, '/api/positioning', { authorization: `Payment ${b64(V2)}` });
  assert.equal(r.status, 200);
});

test('x402 v2 in Authorization on sol-price bypasses the MPP gate and settles as x402', async (t) => {
  const ctx = boot();
  const r = await call(t, ctx, '/api/sol-price', { authorization: `Payment ${b64url(V2)}` });
  assert.equal(r.status, 200, 'MPP gate did not see it');
});

test('x402 v1 in Payment-Authorization is handed over as X-PAYMENT and the MPP header dropped', () => {
  const req = { headers: { 'payment-authorization': `Payment ${b64url({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0x' } })}` } };
  let n = 0; aliasAuthorizationPayment(req, {}, () => n++);
  assert.equal(n, 1);
  assert.equal(unb64(req.headers['x-payment']).x402Version, 1);
  assert.equal(req.headers['payment-authorization'], undefined);
  assert.equal(req.x402FromAuthorization, 'Payment-Authorization');
});

test('an aliased refusal is recorded as such, with both shapes', async (t) => {
  const ctx = boot();
  const r = await call(t, ctx, '/api/positioning', { authorization: `Payment ${b64({ x402Version: 3, payload: {} })}` });
  assert.equal(r.status, 402);
  const [row] = refused(ctx.rows);
  assert.ok(row, 'refusal recorded');
  assert.match(row.error_msg, /mpp Authorization scheme=Payment/);
  assert.equal(r.headers.get('www-authenticate'), null);
});

test('a real MPP credential on sol-price still reaches MPP untouched', async (t) => {
  const ctx = boot();
  const r = await call(t, ctx, '/api/sol-price', { authorization: `Payment ${MPP_CRED}` });
  assert.equal(r.status, 402);
  const [row] = refused(ctx.rows);
  assert.match(row.error_msg, /^malformed-credential: Malformed Credential: mpp saw it; mpp Authorization scheme=Payment .*base64urljson=yes/);
});

test('MPP credential on an x402-only route: the sentence in the challenge and the row', async (t) => {
  const ctx = boot();
  const r = await call(t, ctx, '/api/positioning', { authorization: `Payment ${MPP_CRED}` });
  assert.equal(r.status, 402);
  assert.equal(unb64(r.headers.get('payment-required')).error, MPP_ON_X402_ONLY);
  const [row] = refused(ctx.rows);
  assert.ok(row.error_msg.startsWith(MPP_ON_X402_ONLY + '; mpp Authorization scheme=Payment'), row.error_msg);
});

test('garbage in Authorization is left alone and its shape logged', async (t) => {
  const ctx = boot();
  const r = await call(t, ctx, '/api/positioning', { authorization: 'Payment not!base64' });
  assert.equal(r.status, 402);
  const [row] = refused(ctx.rows);
  assert.match(row.error_msg, /; mpp Authorization scheme=Payment len=10 prefix=aaa\?aaaa base64urljson=no base64json=no dots=0 params=no$/);
});

test('404 logger: unknown GET path once per ip+path per hour, scanners and own 404s skipped', async (t) => {
  const ctx = boot();
  await call(t, ctx, '/api/news');
  await call(t, ctx, '/api/news');
  await call(t, ctx, '/.env');
  await call(t, ctx, '/wp-login.php');
  await call(t, ctx, '/api/sample/nope');
  const nf = ctx.rows.filter((r) => r.status === 'not_found');
  assert.deepStrictEqual(nf.map((r) => r.req_path), ['/api/news']);
  assert.equal(nf[0].tool, 'unknown_route');
});

test('unpaid 402 counter: plain 402s counted per day/route/ip/ua, paid attempts not', async (t) => {
  const ctx = boot();
  await call(t, ctx, '/api/positioning', { 'user-agent': 'reader/1' });
  await call(t, ctx, '/api/positioning', { 'user-agent': 'reader/1' });
  await call(t, ctx, '/api/positioning', { authorization: `Payment ${MPP_CRED}` });
  const rows = ctx.db.prepare('SELECT route, ip, user_agent, n FROM unpaid_402').all();
  assert.deepStrictEqual(rows, [{ route: 'get_positioning', ip: '198.51.100.9', user_agent: 'reader/1', n: 2 }]);
});
