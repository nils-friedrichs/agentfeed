// R17 item 9 (19 Oct 2026): /api/paper/10.1038/nature14539 (a literal slash in the DOI) is the same route as /api/paper/10.1038%2Fnature14539.
// x402-list's path validator allows only letters, digits and / _ . - ~, so neither %2F nor a ?doi= query passed it. Run against the REAL @x402/express
// 2.28 middleware with a stub facilitator and the real key rail, the way keys-daypass.test.js does: both forms answer the same 402 unpaid and the same
// body on a paid call (a comp key), the route table does not change, and nothing else is rewritten.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { makeKeys } = require('../lib/keys');
const { makeTool } = require('../lib/tool');
const { hfUsd } = require('../lib/hf');
const compat = require('../lib/compat');
const { slashPathCanonical, SLASH_PARAM_BASES } = require('../lib/slash-path');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const PRICES = {
  'GET /api/paper/:doi': { usd: 0.005, tool: 'get_paper' },
  'GET /api/papers': { usd: 0.015, tool: 'get_papers' },
};

async function boot({ canon = true } = {}) {
  const db = new Database(':memory:');
  const rows = [];
  const logCall = (r) => rows.push(r);
  const fac = { calls: { settle: 0 },
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { return { isValid: true, payer: PAYER }; },
    async settle() { this.calls.settle++; return { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: PAYER }; } };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  const routes = {};
  for (const [pattern, p] of Object.entries(PRICES)) routes[pattern] = { accepts: [{ scheme: 'exact', price: `$${p.usd}`, network: NET, payTo: PAYTO }], description: p.tool, mimeType: 'application/json' };
  const gate = paymentMiddleware(routes, rs);
  const K = makeKeys({ db, PRICES, logCall, hfUsd, paymentsOn: true });
  const app = express();
  if (canon) app.use(slashPathCanonical());                       // first, as in server.js
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.use(compat.makeGetOnly({ PRICES }));
  app.use(K.charge);
  app.use((req, res, next) => { if (req.keyPaid) return next(); return gate(req, res, next); });
  const { tool } = makeTool({ paymentsOn: true, PRICES, decodeSettlement: (res) => { const raw = res.getHeader('payment-response'); return raw ? unb64(raw) : null; }, logCall });
  app.get('/api/paper/:doi', tool('get_paper', 0.005, (req) => ({ doi: req.params.doi, q: req.query.x || null })));
  app.get('/api/papers', tool('get_papers', 0.015, () => ({ list: true })));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}, init = {}) => fetch(base + p, { headers, ...init });
  await new Promise((r) => setTimeout(r, 30));
  return { K, get, rows, close: () => { K.stop(); server.close(); } };
}

const DOI = '10.1038/nature14539';
const SLASH = `/api/paper/${DOI}`;
const ENCODED = '/api/paper/10.1038%2Fnature14539';

test('slashPathCanonical: a slash in the DOI becomes the one-segment form; everything else is left exactly as it was', () => {
  assert.deepEqual(SLASH_PARAM_BASES, ['/api/paper']);
  const run = (url, method = 'GET') => { const req = { method, url, get path() { return this.url.split('?')[0]; } }; slashPathCanonical()(req, {}, () => {}); return req.url; };
  const cases = [
    [SLASH, ENCODED],
    [`${SLASH}?x=1&y=2`, `${ENCODED}?x=1&y=2`],
    ['/api/paper/10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O', '/api/paper/10.1002%2F(SICI)1097-4571(199806)49%3A8%3C693%3A%3AAID-ASI4%3E3.0.CO%3B2-O'],
    ['/api/paper/10.1038/a/b/c', '/api/paper/10.1038%2Fa%2Fb%2Fc'],
    ['/api/paper/10.1038%2Fa/b', '/api/paper/10.1038%2Fa%2Fb'],
  ];
  for (const [from, to] of cases) assert.equal(run(from), to, from);
  for (const same of [ENCODED, `${ENCODED}?x=1`, '/api/paper/', '/api/paper', '/api/paper/10.1038/', '/api/paper//x', '/api/papers', '/api/papers/a/b', '/api/paperx/a/b', '/api/paper/10.1038/%E0%A4%A', '/api/sol-price', '/', '/api/token-risk/abc/def']) assert.equal(run(same), same, same);
  assert.equal(run(SLASH, 'POST'), SLASH, 'only GET and HEAD');
  assert.equal(run(SLASH, 'HEAD'), ENCODED);
});

test('the slash form and the %2F form answer the same 402 unpaid: same status, same accepts, same price; only the echoed resource URL differs', async (t) => {
  const s = await boot(); t.after(s.close);
  const got = {};
  for (const [name, p] of [['slash', SLASH], ['encoded', ENCODED]]) {
    const r = await s.get(p);
    assert.equal(r.status, 402, name);
    got[name] = unb64(r.headers.get('payment-required'));
  }
  assert.deepEqual(got.slash.accepts, got.encoded.accepts);
  assert.equal(got.slash.accepts[0].amount, '5000', '$0.005');
  assert.equal(got.slash.resource.url.endsWith('/api/paper/10.1038%2Fnature14539') || got.slash.resource.url.endsWith('/api/paper/10.1038/nature14539'), true, got.slash.resource.url);
  // control: without the canonicaliser the slash form is not the route at all
  const bare = await boot({ canon: false }); t.after(bare.close);
  assert.equal((await bare.get(SLASH)).status, 404, 'control: the harness really needs the rewrite');
  assert.equal((await bare.get(ENCODED)).status, 402);
});

test('a paid call (a comp key) is served for both forms with the same body, DOI intact, one draw each; a query string rides along', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grant(1, 'paper');
  const H = { 'x-agentfeed-key': key };
  const a = await s.get(SLASH, H), b = await s.get(ENCODED, H);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.deepEqual(ja, jb, 'one body');
  assert.equal(ja.data.doi, DOI);
  const withQuery = await (await s.get(`${SLASH}?x=7`, H)).json();
  assert.deepEqual([withQuery.data.doi, withQuery.data.q], [DOI, '7']);
  const long = '10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O';
  assert.equal((await (await s.get(`/api/paper/${encodeURIComponent(long).replace(/%2F/g, '/')}`, H)).json()).data.doi, long, 'a DOI with punctuation and one slash');
  await new Promise((r) => setTimeout(r, 20));
  const keyRows = s.rows.filter((r) => r.status === 'key');
  assert.equal(keyRows.length, 4);
  assert.ok(keyRows.every((r) => r.tool === 'get_paper' && r.amount_usdc === 0.0025), 'half the $0.005 price on a key, for both forms');
  // the neighbouring route is untouched
  assert.deepEqual((await (await s.get('/api/papers', H)).json()).data, { list: true });
});

test('a paid x402 call is settled once for each form, at the same price', async (t) => {
  const s = await boot(); t.after(s.close);
  for (const p of [SLASH, ENCODED]) {
    const ch = await s.get(p);
    const pr = unb64(ch.headers.get('payment-required'));
    const sig = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: pr.accepts[0].amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + String(p.length).padStart(2, '0').repeat(32) } } })).toString('base64');
    const paid = await s.get(p, { 'payment-signature': sig });
    assert.equal(paid.status, 200, p);
    assert.equal((await paid.json()).data.doi, DOI);
  }
});
