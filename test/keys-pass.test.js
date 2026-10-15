// The bot pass (15 Oct 2026, task #90): a flat $25 key for 30 days, good only on /api/liq-feed (and the MCP tool of the same name),
// nothing drawn per call. Run against the REAL @x402/express 2.28 middleware with a stub facilitator, the real key rail and the real
// lib/tool.js wrapper (as test/keys.test.js does), plus the real MCP SDK transport for the MCP side.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { makeKeys, makeKeyStore, hashKey, newKey, PASS, publicView, exampleBody, keysSentence } = require('../lib/keys');
const { makeTool } = require('../lib/tool');
const { hfUsd } = require('../lib/hf');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const DAY = 86_400_000;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

const PRICES = {
  'GET /api/liq-feed': { usd: 0.001, tool: 'get_liq_feed' },
  'GET /api/thing': { usd: 0.01, tool: 'get_thing' },
  'GET /api/keys/buy-pass': { usd: 25, tool: 'buy_key_pass', noHf: true },
  'GET /api/keys/buy-1': { usd: 1, tool: 'buy_key_1', noHf: true },
  'GET /api/keys/topup-5': { usd: 5, tool: 'topup_key_5', noHf: true },
};

async function boot({ settle = 'ok' } = {}) {
  const db = new Database(':memory:');
  const clock = { t: 1_800_000_000_000 };
  const rows = [];
  const logCall = (r) => rows.push(r);
  const fac = { calls: { verify: 0, settle: 0 }, mode: settle,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { this.calls.verify++; return { isValid: true, payer: PAYER }; },
    async settle() { this.calls.settle++; return this.mode === 'ok' ? { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: PAYER } : { success: false, errorReason: 'insufficient_funds', transaction: '', network: NET, payer: PAYER }; } };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  const routes = {};
  for (const [pattern, p] of Object.entries(PRICES)) routes[pattern] = { accepts: [{ scheme: 'exact', price: `$${p.usd}`, network: NET, payTo: PAYTO }], description: p.tool, mimeType: 'application/json' };
  const gate = paymentMiddleware(routes, rs);
  const K = makeKeys({ db, PRICES, logCall, hfUsd, paymentsOn: true, now: () => clock.t });
  const gateHits = { n: 0 };
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.use(K.purchaseGuard);
  app.use(K.charge);
  app.use((req, res, next) => { if (req.keyPaid) return next(); gateHits.n++; return gate(req, res, next); });
  const { tool } = makeTool({ paymentsOn: true, PRICES, decodeSettlement: (res) => { const raw = res.getHeader('payment-response'); return raw ? unb64(raw) : null; }, logCall });
  const ok = () => ({ ok: true });
  app.get('/api/liq-feed', tool('get_liq_feed', 0.001, (req) => { if (req.query.fail) throw Object.assign(new Error('bad input'), { kind: 'bad_request' }); return ok(); }));
  app.get('/api/thing', tool('get_thing', 0.01, ok));
  app.get('/api/keys/buy-pass', tool('buy_key_pass', 25, (req) => K.buy(req.query, req, 25, { pass: PASS })));
  app.get('/api/keys/buy-1', tool('buy_key_1', 1, (req) => K.buy(req.query, req, 1)));
  app.get('/api/keys/topup-5', tool('topup_key_5', 5, (req) => K.topup(req.query, req, 5)));
  app.get('/api/keys/balance', K.balance);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'internal' })); // eslint-disable-line no-unused-vars
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  async function pay(p, headers = {}) {
    const ch = await get(p, headers);
    if (ch.status !== 402) return ch;
    const pr = unb64(ch.headers.get('payment-required'));
    const sig = b64({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: pr.accepts[0].amount, validAfter: '0', validBefore: String(2 ** 40), nonce: '0x' + '00'.repeat(32) } } });
    return get(p, { ...headers, 'payment-signature': sig });
  }
  await new Promise((r) => setTimeout(r, 30));
  return { db, rows, fac, K, clock, gateHits, get, pay, close: () => { K.stop(); server.close(); } };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

test('purchase: $25 settles once, the key arrives once, the row is a 30-day pass with no balance and the sale as its sold amount', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.pay('/api/keys/buy-pass');
  assert.equal(r.status, 200);
  const body = (await r.json()).data;
  assert.match(body.key, /^afk_/);
  assert.deepEqual([body.pass.price_usd, body.pass.days, body.pass.routes], [25, 30, ['/api/liq-feed']]);
  assert.match(body.terms, /good only on \/api\/liq-feed/);
  assert.equal(s.fac.calls.settle, 1);
  const row = s.K.store.get(hashKey(body.key));
  assert.equal(row.status, 'active');
  assert.deepEqual([row.balance_micro, row.sold_micro, row.pass_days, row.allow], [0, 25_000_000, 30, '/api/liq-feed']);
  assert.equal(row.expires_at, s.clock.t + 30 * DAY, '30 days from the moment the payment settled');
  assert.equal(JSON.stringify([...s.rows, s.db.prepare('SELECT * FROM api_keys').all()]).includes(body.key), false, 'the key is in no row');
  await flush();
  assert.deepEqual(s.rows.filter((x) => x.status === 'paid').map((x) => [x.tool, x.amount_usdc]), [['buy_key_pass', 25]]);
});

test('purchase with key_hash: the server never sees the key, the pass works on first use; a failed settlement leaves no pass and no key', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = newKey();
  const r = await s.pay(`/api/keys/buy-pass?key_hash=${hashKey(key)}`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.key, undefined);
  assert.equal((await s.get('/api/liq-feed', { 'x-agentfeed-key': key })).status, 200);
  const f = await boot({ settle: 'fail' }); t.after(f.close);
  const bad = await f.pay('/api/keys/buy-pass');
  assert.equal(bad.status, 402);
  assert.ok(!/afk_/.test(await bad.text()), 'the buffered body with the key was discarded');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM api_keys').get().n, 0, 'the pending pass row is gone');
});

test('a pass on its route: 200, nothing drawn, one key row of amount 0, the call counted; the x402 gate is never reached', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 30, label: 'comp' });
  const hash = hashKey(key);
  const hits = s.gateHits.n;
  for (let i = 0; i < 3; i++) assert.equal((await s.get('/api/liq-feed', { 'x-agentfeed-key': key, 'user-agent': 'pass-test/1' })).status, 200);
  await flush();
  const row = s.K.store.get(hash);
  assert.deepEqual([row.balance_micro, row.spent_micro, row.calls, row.sold_micro], [0, 0, 3, 0]);
  assert.equal(s.gateHits.n, hits, 'no x402 challenge for a pass call');
  const keyRows = s.rows.filter((x) => x.status === 'key');
  assert.equal(keyRows.length, 3);
  assert.ok(keyRows.every((x) => x.tool === 'get_liq_feed' && x.amount_usdc === 0 && x.req_path === '/api/liq-feed' && x.user_agent === 'pass-test/1'));
  assert.equal(JSON.stringify(s.rows).includes(key), false);
});

test('a pass on any other priced route is a 403 and counts nothing; a failed call on its own route is not counted either', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 30, label: 'comp' });
  const hits = s.gateHits.n;
  const r = await s.get('/api/thing', { 'x-agentfeed-key': key });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /bot pass, good only on \/api\/liq-feed/);
  assert.equal(s.gateHits.n, hits, 'never falls through to x402');
  assert.equal((await s.get('/api/liq-feed?fail=1', { 'x-agentfeed-key': key })).status, 400);
  await flush();
  assert.equal(s.K.store.get(hashKey(key)).calls, 0);
  assert.equal(s.rows.filter((x) => x.status === 'key').length, 0);
});

test('expiry: valid up to the second, refused after with the date and the buy path, never billed elsewhere; the balance route says expired', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 30, label: 'comp' });
  s.clock.t += 30 * DAY - 1000;
  assert.equal((await s.get('/api/liq-feed', { 'x-agentfeed-key': key })).status, 200);
  const hits = s.gateHits.n;
  s.clock.t += 1000;
  const r = await s.get('/api/liq-feed', { 'x-agentfeed-key': key });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.match(j.error, /bot pass expired on 20\d\d-\d\d-\d\d/);
  assert.equal(j.buy, '/api/keys/buy-pass');
  assert.equal(s.gateHits.n, hits);
  const b = await (await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).json();
  assert.equal(b.status, 'expired');
  assert.deepEqual([b.pass.routes, b.pass.days_left, b.balance_usd], [['/api/liq-feed'], 0, 0]);
  assert.equal(JSON.stringify(b).includes(key), false);
});

test('balance of a live pass: the routes, the expiry and the days left; revoked is refused', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 30, label: 'comp' });
  s.clock.t += 5 * DAY + 1000;
  const b = await (await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).json();
  assert.equal(b.status, 'active');
  assert.deepEqual([b.pass.routes, b.pass.days_left], [['/api/liq-feed'], 25]);
  assert.equal(b.pass.expires_at, new Date(1_800_000_000_000 + 30 * DAY).toISOString());
  s.K.store.setStatus(hashKey(key), 'revoked');
  const r = await s.get('/api/liq-feed', { 'x-agentfeed-key': key });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /revoked/);
});

test('a pass cannot be topped up: 400 before any payment is verified, even with a payment attached', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 30, label: 'comp' });
  const v = s.fac.calls.verify;
  const r = await s.pay('/api/keys/topup-5', { 'x-agentfeed-key': key });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /cannot be topped up/);
  assert.equal(s.fac.calls.verify, v);
  assert.equal(s.fac.calls.settle, 0);
});

test('an ordinary key is unchanged: it draws the half price on every route, the liq-feed included, and tops up', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grant(1, 'ordinary');
  const hash = hashKey(key);
  assert.equal((await s.get('/api/thing', { 'x-agentfeed-key': key })).status, 200);
  assert.equal((await s.get('/api/liq-feed', { 'x-agentfeed-key': key })).status, 200);
  await flush();
  assert.equal(s.K.store.get(hash).balance_micro, 1_000_000 - 5_000 - 500);
  assert.equal(s.K.store.get(hash).allow, null);
  assert.equal((await s.pay('/api/keys/topup-5', { 'x-agentfeed-key': key })).status, 200);
  assert.equal(s.K.store.get(hash).balance_micro, 1_000_000 - 5_500 + 5_000_000);
  const b = await (await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).json();
  assert.equal('pass' in b, false);
});

test('migration: a table that predates the pass gets the three columns, its rows read as ordinary keys', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, prefix TEXT, status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
    balance_micro INTEGER NOT NULL DEFAULT 0, sold_micro INTEGER NOT NULL DEFAULT 0, spent_micro INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, last_used INTEGER, buyer TEXT, purchase_tx TEXT, rate_per_min INTEGER NOT NULL DEFAULT 120, label TEXT);
    INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, created) VALUES ('${'a'.repeat(64)}', 'abcdefgh', 'active', 1000000, 1000000, 1);`);
  const store = makeKeyStore(db);
  const cols = db.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name);
  for (const c of ['pass_days', 'expires_at', 'allow']) assert.ok(cols.includes(c), c);
  const old = store.get('a'.repeat(64));
  assert.deepEqual([old.balance_micro, old.pass_days, old.expires_at, old.allow], [1_000_000, null, null, null]);
  assert.equal(store.reserve('a'.repeat(64), 5000), true);
  makeKeyStore(db);                                                          // a second start changes nothing
  assert.equal(db.prepare('SELECT COUNT(*) n FROM api_keys').get().n, 1);
});

test('text: the keys sentence mentions the pass only when the pass route is in the table; the example body has a placeholder key and the terms', () => {
  assert.doesNotMatch(keysSentence({ 'GET /api/keys/buy-1': { usd: 1 } }), /bot pass/);
  const s = keysSentence(PRICES);
  assert.match(s, /30-day bot pass for \/api\/liq-feed is \$25 flat/);
  assert.match(s, /\$1\)|\(\$1[;,)]/);
  assert.doesNotMatch(s, /\$25[,;]/, 'the pass is not listed as a pack');
  const ex = exampleBody('buy_key_pass');
  assert.match(ex.key, /^afk_x+$/);
  assert.deepEqual(ex.pass.routes, ['/api/liq-feed']);
  assert.equal(JSON.stringify(ex).includes('non-refundable'), true);
  assert.equal(publicView({ prefix: 'p', balance_micro: 0, calls: 0, spent_micro: 0, rate_per_min: 120, status: 'active', allow: '/api/liq-feed', expires_at: 2_000 }, 1_000).status, 'active');
});

// ---- MCP: the same pass on POST /mcp, through the real SDK transport
async function bootMcp() {
  const db = new Database(':memory:');
  const clock = { t: 1_800_000_000_000 };
  const rows = [];
  const K = makeKeys({ db, PRICES, logCall: (r) => rows.push(r), hfUsd, now: () => clock.t });
  const DEFS = [{ name: 'get_liq_feed', usd: 0.001 }, { name: 'get_thing', usd: 0.01 }];
  const x402 = { n: 0 };
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.post('/mcp', express.json(), async (req, res) => {
    const s = new McpServer({ name: 't', version: '1.0.0' });
    for (const def of DEFS) {
      const wrap = K.mcpWrap(req, def) || ((h) => async () => { x402.n++; return { isError: true, content: [{ type: 'text', text: 'x402 payment required' }] }; }); // eslint-disable-line no-unused-vars
      s.registerTool(def.name, { description: def.name, inputSchema: { symbols: z.string().optional() } }, wrap(async () => ({ content: [{ type: 'text', text: JSON.stringify({ tool: def.name, ok: true }) }] })));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await s.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  let id = 0;
  const call = async (name, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: {} } }) });
    return (await r.json()).result;
  };
  return { K, rows, clock, x402, call, close: () => { K.stop(); server.close(); } };
}

test('MCP: a pass is allowed on get_liq_feed (amount 0, /mcp, the user agent), refused on every other tool, refused when expired; x402 is never touched', async (t) => {
  const s = await bootMcp(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 30, label: 'comp' });
  const okR = await s.call('get_liq_feed', { 'x-agentfeed-key': key, 'user-agent': 'mcp-pass/1' });
  assert.equal(okR.isError, undefined);
  const other = await s.call('get_thing', { 'x-agentfeed-key': key });
  assert.equal(other.isError, true);
  const j = JSON.parse(other.content[0].text);
  assert.deepEqual([j.status, j.routes], [403, ['/api/liq-feed']]);
  const row = s.K.store.get(hashKey(key));
  assert.deepEqual([row.balance_micro, row.calls], [0, 1]);
  const keyRows = s.rows.filter((x) => x.status === 'key');
  assert.equal(keyRows.length, 1);
  assert.deepEqual([keyRows[0].tool, keyRows[0].amount_usdc, keyRows[0].req_path, keyRows[0].user_agent, keyRows[0].method], ['get_liq_feed', 0, '/mcp', 'mcp-pass/1', 'POST']);
  s.clock.t += 31 * DAY;
  const exp = await s.call('get_liq_feed', { 'x-agentfeed-key': key });
  assert.equal(exp.isError, true);
  assert.match(JSON.parse(exp.content[0].text).error, /bot pass expired on/);
  assert.equal(s.x402.n, 0);
});
