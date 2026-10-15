// R13 item 3 (15 Oct 2026): discovery documents and unpaid challenges on priced paths have their own per-address buckets, so a registry
// prober's 90-route sweep cannot make /openapi.json answer 429 (x402scan's `agentcash register`, 18:22:58 and 18:24:46 UTC), while
// requests that carry a payment, and the free data routes, keep the 240/min bucket. Real HTTP through the real limiter; the layers
// behind it are stubs that answer what the x402 layer answers (402 with no payment header, 200 with one).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { makeRateLimiter, DOC_PATH, LIMITS } = require('../lib/ratelimit');
const { presentsPayment } = require('../lib/keys');

const PRICED = new Set(['/api/sol-price', '/api/token-risk/abc', '/api/keys/buy-pass']);
const isPricedPath = (p) => PRICED.has(p);

async function boot({ priced = isPricedPath, limits } = {}) {
  const rows = [];
  const rl = makeRateLimiter({ logCall: (r) => rows.push(r), isPricedPath: priced, presentsPayment, limits });
  const app = express();
  // keys.identify stand-in: a test header says what the key layer decided
  app.use((req, _res, next) => { if (req.headers['x-test-key'] === 'inactive') req.afKey = { presented: true, active: false }; if (req.headers['x-test-key'] === 'active') req.afKey = { presented: true, active: true }; next(); });
  app.use(rl.middleware);
  app.use((req, res) => {
    if (DOC_PATH.test(req.path)) return res.type('text/plain').send('doc');
    if (isPricedPath(req.path) && !presentsPayment(req)) return res.status(402).json({ error: 'Payment required' });
    return res.json({ ok: true });
  });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const hit = (path, { ip = '203.0.113.7', headers = {}, method = 'GET' } = {}) =>
    fetch(base + path, { method, headers: { 'cf-connecting-ip': ip, ...headers } }).then(async (r) => { await r.arrayBuffer(); return r; });
  // n requests, 25 at a time; returns the status histogram
  const many = async (n, path, opts) => {
    const counts = {};
    for (let i = 0; i < n; i += 25) {
      const rs = await Promise.all(Array.from({ length: Math.min(25, n - i) }, () => hit(path, opts)));
      for (const r of rs) counts[r.status] = (counts[r.status] || 0) + 1;
    }
    return counts;
  };
  return { rows, rl, hit, many, close: () => server.close() };
}

test('300 unpaid GETs from one address in a minute all get the 402 challenge', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.deepEqual(await s.many(300, '/api/sol-price'), { 402: 300 });
  assert.equal(s.rows.length, 0);
});

test('control, the old limiter: with unpaid challenges counted in the one GET bucket the 241st unpaid GET is a 429', async (t) => {
  const s = await boot({ priced: () => false }); t.after(s.close);   // nothing classed as a priced path = every GET in the 'metered' bucket
  assert.deepEqual(await s.many(300, '/api/sol-price'), { 402: 240, 429: 60 });
});

test('a flood of paid requests still gets 429 at 240 a minute, with Retry-After and one logged row', async (t) => {
  const s = await boot(); t.after(s.close);
  const paid = { headers: { 'payment-signature': 'x' } };
  assert.deepEqual(await s.many(300, '/api/sol-price', paid), { 200: 240, 429: 60 });
  const r = await s.hit('/api/sol-price', paid);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal(s.rows.length, 1);
  assert.match(s.rows[0].error_msg, /rate limit: 240 req\/min exceeded on the GET \+ POST \/mcp bucket \(retry after \d+s\)/);
  assert.equal(s.rows[0].tool, 'rate_limited');
});

test('every other way of presenting a payment stays on the 240 bucket: X-PAYMENT, Authorization: Payment, a key', async (t) => {
  for (const headers of [{ 'x-payment': 'x' }, { authorization: 'Payment abc' }, { 'payment-authorization': 'Payment abc' }, { 'x-test-key': 'inactive' }]) {
    const s = await boot();
    assert.deepEqual(await s.many(260, '/api/sol-price', { headers }), { [headers['x-test-key'] ? 402 : 200]: 240, 429: 20 }, JSON.stringify(headers));
    s.close();
  }
});

test('free data routes and POST /mcp stay on the 240 bucket', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.deepEqual(await s.many(250, '/api/sample/get_thing'), { 200: 240, 429: 10 });
  assert.equal(s.rl.classify({ method: 'POST', path: '/mcp', headers: {} }), 'metered');
});

test('the four buckets do not draw on each other', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.deepEqual(await s.many(300, '/api/sol-price'), { 402: 300 });                                   // the sweep
  assert.equal((await s.hit('/openapi.json')).status, 200);                                               // the document the prober fetches next
  assert.equal((await s.hit('/.well-known/x402.json')).status, 200);
  assert.deepEqual(await s.many(240, '/api/sol-price', { headers: { 'payment-signature': 'x' } }), { 200: 240 }); // a buyer on the same address
  assert.equal((await s.hit('/api/sample/x')).status, 429);                                               // the 240 is spent, and only that bucket
  assert.equal((await s.hit('/openapi.json')).status, 200);
  assert.equal((await s.hit('/api/sol-price')).status, 402);
});

test('discovery documents: 120 a minute, then 429 with Retry-After and one row; the same documents are never counted in the 240', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.deepEqual(await s.many(125, '/openapi.json'), { 200: 120, 429: 5 });
  assert.equal(s.rows.length, 1);
  assert.match(s.rows[0].error_msg, /rate limit: 120 req\/min exceeded on the discovery documents bucket/);
  assert.ok(Number((await s.hit('/llms.txt')).headers.get('retry-after')) >= 1);
  assert.equal((await s.hit('/api/sample/x')).status, 200);
});

test('unpaid challenges: 1,200 a minute, then 429; one row names the bucket', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.deepEqual(await s.many(1210, '/api/sol-price'), { 402: 1200, 429: 10 });
  assert.equal(s.rows.length, 1);
  assert.match(s.rows[0].error_msg, /rate limit: 1200 req\/min exceeded on the unpaid challenge bucket/);
});

test('addresses have their own buckets', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.deepEqual(await s.many(125, '/openapi.json', { ip: '198.51.100.1' }), { 200: 120, 429: 5 });
  assert.deepEqual(await s.many(10, '/openapi.json', { ip: '198.51.100.2' }), { 200: 10 });
});

test('an active key skips the address buckets entirely (its own per-key bucket applies in keys.identify)', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.deepEqual(await s.many(300, '/api/sample/x', { headers: { 'x-test-key': 'active' } }), { 200: 300 });
});

test('classification table', () => {
  const rl = makeRateLimiter({ logCall() {}, isPricedPath, presentsPayment });
  const c = (method, path, headers = {}, afKey) => rl.classify({ method, path, headers, afKey });
  for (const p of ['/openapi.json', '/llms.txt', '/SKILL.md', '/.well-known/x402', '/.well-known/x402.json', '/.well-known/x402/discovery/resources']) assert.equal(c('GET', p), 'docs', p);
  for (const p of ['/openapi.jsonx', '/x/openapi.json', '/.well-known/x402x', '/.well-known/agent.json', '/pricing']) assert.notEqual(c('GET', p), 'docs', p);
  assert.equal(c('GET', '/api/sol-price'), 'unpaid');
  assert.equal(c('GET', '/api/sol-price', { 'payment-signature': 'x' }), 'metered');
  assert.equal(c('GET', '/api/sol-price', {}, { presented: true, active: false }), 'metered');
  assert.equal(c('GET', '/api/unknown'), 'metered');
  assert.equal(c('HEAD', '/api/sol-price'), 'other');
  assert.equal(c('HEAD', '/openapi.json'), 'other');
  assert.equal(c('HEAD', '/api/free-route'), 'metered');
  assert.equal(c('OPTIONS', '/api/sol-price'), 'other');
  assert.equal(c('POST', '/mcp'), 'metered');
  assert.deepEqual(rl.limits, LIMITS);
  assert.deepEqual(LIMITS, { metered: 240, other: 2400, docs: 120, unpaid: 1200 });
});
