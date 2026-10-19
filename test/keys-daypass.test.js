// The day pass (R15, 19 Oct 2026): $1.00 flat for 24 hours, good only on /api/liq-feed and /api/liquidations, the bot-pass key mechanism
// with a different term and two routes. $1.00 is the most a stock @x402/fetch 2.28 client pays with its default spend cap. Run against
// the REAL @x402/express 2.28 middleware with a stub facilitator, the real key rail and lib/tool.js (as keys-pass.test.js does), and the
// real MCP SDK transport for the MCP side. The stock-client purchase (Base and Solana, signing but not sending) is ops/stock-client-check.mjs,
// run against the staged server; its Base half is repeated here against this file's server.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { ExactEvmScheme: ExactEvmClient } = require('@x402/evm/exact/client');
const { wrapFetchWithPaymentFromConfig } = require('@x402/fetch');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const KL = require('../lib/keys');
const { makeKeys, hashKey, newKey, DAY_PASS, PASS, exampleBody, keysSentence } = KL;
const { makeTool } = require('../lib/tool');
const { hfUsd } = require('../lib/hf');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

const PRICES = {
  'GET /api/liq-feed': { usd: 0.001, tool: 'get_liq_feed' },
  'GET /api/liquidations': { usd: 0.005, tool: 'get_recent_liquidations' },
  'GET /api/thing': { usd: 0.01, tool: 'get_thing' },
  'GET /api/keys/buy-day-pass': { usd: 1, tool: 'buy_key_day_pass', noHf: true },
  'GET /api/keys/buy-pass': { usd: 25, tool: 'buy_key_pass', noHf: true },
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
  app.get('/api/liq-feed', tool('get_liq_feed', 0.001, ok));
  app.get('/api/liquidations', tool('get_recent_liquidations', 0.005, ok));
  app.get('/api/thing', tool('get_thing', 0.01, ok));
  app.get('/api/keys/buy-day-pass', tool('buy_key_day_pass', 1, (req) => K.buy(req.query, req, 1, { pass: DAY_PASS })));
  app.get('/api/keys/buy-pass', tool('buy_key_pass', 25, (req) => K.buy(req.query, req, 25, { pass: PASS })));
  app.get('/api/keys/topup-5', tool('topup_key_5', 5, (req) => K.topup(req.query, req, 5)));
  app.get('/api/keys/balance', K.balance);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'internal' })); // eslint-disable-line no-unused-vars
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  await new Promise((r) => setTimeout(r, 30));
  return { db, rows, fac, K, clock, gateHits, get, base, close: () => { K.stop(); server.close(); } };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

test('the day pass is $1.00 for 24 hours on exactly two routes, and a 30-day bot pass is still what it was', () => {
  assert.deepEqual([DAY_PASS.usd, DAY_PASS.days, DAY_PASS.allow, DAY_PASS.path], [1, 1, ['/api/liq-feed', '/api/liquidations'], '/api/keys/buy-day-pass']);
  assert.deepEqual([PASS.usd, PASS.days, PASS.allow, PASS.path], [25, 30, ['/api/liq-feed'], '/api/keys/buy-pass']);
  assert.equal(KL.passOf({ pass_days: 1, allow: '/api/liq-feed,/api/liquidations' }), DAY_PASS);
  assert.equal(KL.passOf({ pass_days: 30, allow: '/api/liq-feed' }), PASS);
  assert.equal(KL.passOf({ pass_days: 7, allow: '/api/liq-feed' }), PASS, 'a comp pass of another length reads as the bot pass');
});

test('a stock @x402/fetch client with default settings buys the day pass on Base: it signs exactly $1.00; the $5 pack and the $25 pass are refused by the same client (control)', async (t) => {
  const s = await boot(); t.after(s.close);
  const account = privateKeyToAccount(generatePrivateKey());
  const seen = [];
  // signing but not sending: the paid retry is caught here and answered 200, so the stub facilitator is never asked
  const catcher = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const sig = req.headers.get('payment-signature');
    if (sig) { seen.push(unb64(sig)); return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    return fetch(req);
  };
  const pay = wrapFetchWithPaymentFromConfig(catcher, { schemes: [{ network: NET, client: new ExactEvmClient(account) }] }); // no spendControls: the defaults
  const r = await pay(`${s.base}/api/keys/buy-day-pass`);
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1, 'one payment was signed');
  assert.deepEqual([seen[0].accepted.amount, seen[0].accepted.network, seen[0].accepted.payTo], ['1000000', NET, PAYTO]);
  assert.equal(seen[0].payload.authorization.value, '1000000');
  assert.equal(s.fac.calls.settle, 0, 'nothing was sent to the facilitator');
  for (const path of ['/api/keys/buy-pass', '/api/keys/topup-5']) {
    await assert.rejects(pay(`${s.base}${path}`), /spendControls\.maxAmountPerPayment \(\$1/, `${path}: refused by the default cap`);
  }
  assert.equal(seen.length, 1, 'nothing else was signed');
});

test('purchase: $1.00 settles once, the key arrives once, the row is a 24-hour pass on two routes with no balance and the sale as its sold amount', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = newKey();
  const pay = async (path) => {
    const ch = await s.get(path);
    const pr = unb64(ch.headers.get('payment-required'));
    const sig = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: pr.accepts[0].amount, validAfter: '0', validBefore: String(2 ** 40), nonce: '0x' + '00'.repeat(32) } } })).toString('base64');
    return s.get(path, { 'payment-signature': sig });
  };
  const r = await pay('/api/keys/buy-day-pass');
  assert.equal(r.status, 200);
  const body = (await r.json()).data;
  assert.match(body.key, /^afk_/);
  assert.deepEqual([body.pass.price_usd, body.pass.days, body.pass.routes, body.pass.expires], [1, 1, ['/api/liq-feed', '/api/liquidations'], '24 hours after that']);
  assert.match(body.terms, /^a 24-hour day pass for a flat \$1, good only on \/api\/liq-feed, \/api\/liquidations, non-refundable, cannot be topped up/);
  assert.equal(s.fac.calls.settle, 1);
  const row = s.K.store.get(hashKey(body.key));
  assert.deepEqual([row.status, row.balance_micro, row.sold_micro, row.pass_days, row.allow], ['active', 0, 1_000_000, 1, '/api/liq-feed,/api/liquidations']);
  assert.equal(row.expires_at, s.clock.t + DAY, '24 hours from the moment the payment settled');
  assert.equal(JSON.stringify([...s.rows, s.db.prepare('SELECT * FROM api_keys').all()]).includes(body.key), false, 'the key is in no row');
  await flush();
  assert.deepEqual(s.rows.filter((x) => x.status === 'paid').map((x) => [x.tool, x.amount_usdc]), [['buy_key_day_pass', 1]]);
  // the key works at once, on both routes, nothing drawn, and without a payment
  const hits = s.gateHits.n;
  let n = 0;
  for (const p of ['/api/liq-feed', '/api/liquidations', '/api/liquidations']) {
    if (p === '/api/liquidations' && n++) s.clock.t += 10_000;   // R15c: /api/liquidations is one call every 10 seconds per day-pass key
    assert.equal((await s.get(p, { 'x-agentfeed-key': body.key })).status, 200, p);
  }
  assert.equal(s.gateHits.n, hits, 'no x402 challenge for a pass call');
  await flush();
  const after = s.K.store.get(hashKey(body.key));
  assert.deepEqual([after.balance_micro, after.spent_micro, after.calls], [0, 0, 3]);
  assert.deepEqual(s.rows.filter((x) => x.status === 'key').map((x) => [x.tool, x.amount_usdc, x.req_path]), [['get_liq_feed', 0, '/api/liq-feed'], ['get_recent_liquidations', 0, '/api/liquidations'], ['get_recent_liquidations', 0, '/api/liquidations']]);
});

test('the day pass is a 403 on every other priced route, and never falls through to x402', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp' });
  const hits = s.gateHits.n;
  const r = await s.get('/api/thing', { 'x-agentfeed-key': key });
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.match(j.error, /^this key is a day pass, good only on \/api\/liq-feed, \/api\/liquidations$/);
  assert.deepEqual(j.routes, ['/api/liq-feed', '/api/liquidations']);
  assert.equal(s.gateHits.n, hits);
});

test('expiry after 24 hours: valid to the millisecond, then 401 with the date, the minute and the day-pass buy path; balance says expired with 0 hours left', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp' });
  s.clock.t += DAY - 1;
  assert.equal((await s.get('/api/liquidations', { 'x-agentfeed-key': key })).status, 200);
  const live = await (await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).json();
  assert.deepEqual([live.status, live.pass.kind, live.pass.hours_left, live.pass.days_left], ['active', 'day', 1, 1]);
  const hits = s.gateHits.n;
  s.clock.t += 1;
  for (const p of ['/api/liq-feed', '/api/liquidations']) {
    const r = await s.get(p, { 'x-agentfeed-key': key });
    assert.equal(r.status, 401, p);
    const j = await r.json();
    assert.equal(j.error, `this day pass expired on ${new Date(1_800_000_000_000 + DAY).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    assert.equal(j.buy, '/api/keys/buy-day-pass');
  }
  assert.equal(s.gateHits.n, hits, 'an expired pass is never billed elsewhere');
  const b = await (await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).json();
  assert.deepEqual([b.status, b.pass.hours_left, b.pass.days_left, b.balance_usd], ['expired', 0, 0, 0]);
  // and the 30-day bot pass keeps its own text and path
  const bot = s.K.store.grantPass({ days: 30, label: 'comp' });
  s.clock.t += 31 * DAY;
  const j2 = await (await s.get('/api/liq-feed', { 'x-agentfeed-key': bot })).json();
  assert.match(j2.error, /^this bot pass expired on 20\d\d-\d\d-\d\d$/);
  assert.equal(j2.buy, '/api/keys/buy-pass');
});

test('a day pass cannot be topped up, and says which pass to buy again', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp' });
  const r = await s.get('/api/keys/topup-5', { 'x-agentfeed-key': key, 'payment-signature': 'x' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /^a day pass cannot be topped up/);
  assert.equal(j.buy, '/api/keys/buy-day-pass');
});

test('MCP: the day pass is allowed on get_liq_feed and get_recent_liquidations, refused on every other tool, refused when expired', async (t) => {
  const db = new Database(':memory:');
  const clock = { t: 1_800_000_000_000 };
  const rows = [];
  const K = makeKeys({ db, PRICES, logCall: (r) => rows.push(r), hfUsd, now: () => clock.t });
  t.after(() => K.stop());
  const DEFS = [{ name: 'get_liq_feed', usd: 0.001 }, { name: 'get_recent_liquidations', usd: 0.005 }, { name: 'get_thing', usd: 0.01 }];
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.post('/mcp', express.json(), async (req, res) => {
    const srv = new McpServer({ name: 't', version: '1.0.0' });
    for (const def of DEFS) {
      const wrap = K.mcpWrap(req, def) || ((h) => async () => ({ isError: true, content: [{ type: 'text', text: 'x402 payment required' }] })); // eslint-disable-line no-unused-vars
      srv.registerTool(def.name, { description: def.name, inputSchema: { symbols: z.string().optional() } }, wrap(async () => ({ content: [{ type: 'text', text: JSON.stringify({ tool: def.name, ok: true }) }] })));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  t.after(() => server.close());
  let id = 0;
  const call = async (name, headers) => (await (await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: {} } }) })).json()).result;
  const key = K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp' });
  assert.equal((await call('get_liq_feed', { 'x-agentfeed-key': key })).isError, undefined);
  assert.equal((await call('get_recent_liquidations', { 'x-agentfeed-key': key })).isError, undefined);
  const other = JSON.parse((await call('get_thing', { 'x-agentfeed-key': key })).content[0].text);
  assert.deepEqual([other.status, other.routes], [403, DAY_PASS.allow]);
  assert.match(other.error, /^this key is a day pass/);
  assert.deepEqual(rows.filter((x) => x.status === 'key').map((x) => [x.tool, x.amount_usdc, x.req_path]), [['get_liq_feed', 0, '/mcp'], ['get_recent_liquidations', 0, '/mcp']]);
  clock.t += DAY;
  const exp = JSON.parse((await call('get_recent_liquidations', { 'x-agentfeed-key': key })).content[0].text);
  assert.deepEqual([exp.status, exp.buy], [401, '/api/keys/buy-day-pass']);
  assert.match(exp.error, /^this day pass expired on 20\d\d-\d\d-\d\d \d\d:\d\d UTC$/);
});

test('text: the example body is a day-pass body with a placeholder key; the keys sentence names the pass once, at $1, and is not counted among the dear purchases', () => {
  const ex = exampleBody('buy_key_day_pass');
  assert.match(ex.key, /^afk_x+$/);
  assert.deepEqual([ex.pass.price_usd, ex.pass.days, ex.pass.routes, ex.pass.expires], [1, 1, DAY_PASS.allow, '24 hours after that']);
  assert.match(ex.terms, /24-hour day pass for a flat \$1/);
  assert.match(ex.use, /; each route answers one call every 10 seconds per key \(6 a minute\)$/, 'R15c: the purchase body states the cadence, for both routes');
  assert.ok(ex.use.length <= 260, `the static Bazaar example is clamped to 260 characters by gen-bazaar-meta.js (${ex.use.length})`);
  assert.doesNotMatch(exampleBody('buy_key_pass').use, /\/api\/liquidations/, 'the 30-day pass body is unchanged');
  assert.match(exampleBody('buy_key_pass').use, /\/api\/liq-feed answers one call per 10 seconds per key$/);
  const all = { 'GET /api/keys/buy-1': { usd: 1 }, 'GET /api/keys/buy-5': { usd: 5 }, 'GET /api/keys/buy-20': { usd: 20 }, 'GET /api/keys/buy-pass': { usd: 25 }, 'GET /api/keys/buy-day-pass': { usd: 1 } };
  const s = keysSentence(all);
  assert.match(s, /A 24-hour day pass for \/api\/liq-feed and \/api\/liquidations is \$1 flat \(\/api\/keys\/buy-day-pass\), each route one call every 10 seconds per key \(6 a minute\): at that price a default x402 client buys it as is\./);
  assert.match(s, /prepaid key once \(\$1, \$5, \$20; page at \/keys\)/, 'the day pass is not listed as a pack');
  assert.match(s, /which the \$5, \$20, \$25 purchases need\.$/, 'and it is not one of the purchases that need the cap raised');
  assert.doesNotMatch(keysSentence({ 'GET /api/keys/buy-1': { usd: 1 } }), /day pass/, 'no sentence when the route is not in the table');
});

// ---- R15c (19 Oct 2026): a day-pass key gets /api/liquidations once every 10 seconds, six a minute, the cadence of /api/liq-feed -------------
// The route caps at 100 rows with no paging, so this stops a $1 pass from mirroring the tape at 120 a minute while a 10-second poller loses nothing.
// x402 callers and prepaid packs are not paced; the 30-day bot pass is not paced by lib/keys.js (liq-feed has its own gate in tools/liqfeed.js).

test('R15c REST: one /api/liquidations call per 10 seconds per day-pass key; the refusal is a 429 with Retry-After, is not billed, and does not restart the clock', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp' });
  const H = { 'x-agentfeed-key': key };
  assert.equal((await s.get('/api/liquidations', H)).status, 200, 'the first call is admitted');
  await flush();
  const callsAfterFirst = s.K.store.get(hashKey(key)).calls;
  const hits = s.gateHits.n, rowsBefore = s.rows.length;
  const r = await s.get('/api/liquidations', H);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '10');
  const j = await r.json();
  assert.equal(j.retry_after, 10);
  assert.match(j.error, /^this day pass answers \/api\/liquidations one call every 10 s per key \(6 a minute\)\. Retry in 10 s\.$/);
  assert.ok(!('data' in j) && !('rows' in j) && !('count' in j), 'no row and no count in a refusal');
  assert.equal(s.gateHits.n, hits, 'a paced refusal never falls through to an x402 challenge');
  await flush();
  assert.equal(s.K.store.get(hashKey(key)).calls, callsAfterFirst, 'not counted');
  assert.equal(s.rows.length, rowsBefore, 'no call row for the refusal');
  s.clock.t += 9_999;
  const late = await s.get('/api/liquidations', H);
  assert.equal(late.status, 429, '1 ms short of the 10 seconds');
  assert.equal(late.headers.get('retry-after'), '1');
  s.clock.t += 1;
  assert.equal((await s.get('/api/liquidations', H)).status, 200, 'exactly 10 s after the first call: admitted (the refusals did not restart the clock)');
  assert.equal((await s.get('/api/liquidations', H)).status, 429, 'and the clock starts again from that call');
  // six a minute: a call every 10 s for a minute is six admitted calls, none refused
  const key2 = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp2' });
  const seen = [];
  for (let i = 0; i < 6; i++) { seen.push((await s.get('/api/liquidations', { 'x-agentfeed-key': key2 })).status); s.clock.t += 10_000; }
  assert.deepEqual(seen, [200, 200, 200, 200, 200, 200], 'a 10-second poller loses nothing');
});

test('R15c REST: the pace is per key and per route; /api/liq-feed is not paced here; x402 callers and prepaid packs are not paced', async (t) => {
  const s = await boot(); t.after(s.close);
  const a = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'a' });
  const b = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'b' });
  assert.equal((await s.get('/api/liquidations', { 'x-agentfeed-key': a })).status, 200);
  assert.equal((await s.get('/api/liquidations', { 'x-agentfeed-key': a })).status, 429);
  assert.equal((await s.get('/api/liquidations', { 'x-agentfeed-key': b })).status, 200, 'another key has its own clock');
  for (let i = 0; i < 3; i++) assert.equal((await s.get('/api/liq-feed', { 'x-agentfeed-key': a })).status, 200, 'liq-feed has its own gate (tools/liqfeed.js), not this one');
  // a prepaid pack key: back to back, as before
  const pack = s.K.store.grant(1, 'pack');
  for (let i = 0; i < 5; i++) assert.equal((await s.get('/api/liquidations', { 'x-agentfeed-key': pack })).status, 200, `pack call ${i}`);
  // the 30-day bot pass is a different pass: no pace in keys.js
  const bot = s.K.store.grantPass({ days: 30, label: 'bot' });
  for (let i = 0; i < 3; i++) assert.equal((await s.get('/api/liq-feed', { 'x-agentfeed-key': bot })).status, 200);
  // x402: a caller with no key reaches the payment layer every time, however fast
  const hits = s.gateHits.n;
  for (let i = 0; i < 4; i++) assert.equal((await s.get('/api/liquidations')).status, 402);
  assert.equal(s.gateHits.n, hits + 4, 'four unpaid calls, four x402 challenges: nothing is paced');
});

test('R15c REST: the pace is memory only; a restart forgets it at the cost of one early call', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp' });
  assert.equal((await s.get('/api/liquidations', { 'x-agentfeed-key': key })).status, 200);
  assert.equal((await s.get('/api/liquidations', { 'x-agentfeed-key': key })).status, 429);
  const fresh = makeKeys({ db: s.db, PRICES, logCall: () => {}, hfUsd, now: () => s.clock.t });   // what a restarted process has: same database, no pace
  t.after(() => fresh.stop());
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(fresh.identify); app.use(fresh.charge);
  app.get('/api/liquidations', (_req, res) => res.json({ ok: true }));
  const srv = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/api/liquidations`;
  assert.equal((await fetch(url, { headers: { 'x-agentfeed-key': key } })).status, 200, 'the restarted process admits the first call');
  assert.equal((await fetch(url, { headers: { 'x-agentfeed-key': key } })).status, 429, 'and paces from there');
});

test('R15c MCP: the same pace on get_recent_liquidations, none on get_liq_feed; the refusal is a tool error with status 429 and retry_after', async (t) => {
  const db = new Database(':memory:');
  const clock = { t: 1_800_000_000_000 };
  const rows = [];
  const K = makeKeys({ db, PRICES, logCall: (r) => rows.push(r), hfUsd, now: () => clock.t });
  t.after(() => K.stop());
  const DEFS = [{ name: 'get_liq_feed', usd: 0.001 }, { name: 'get_recent_liquidations', usd: 0.005 }];
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.post('/mcp', express.json(), async (req, res) => {
    const srv = new McpServer({ name: 't', version: '1.0.0' });
    for (const def of DEFS) {
      const wrap = K.mcpWrap(req, def) || ((h) => async () => ({ isError: true, content: [{ type: 'text', text: 'x402 payment required' }] })); // eslint-disable-line no-unused-vars
      srv.registerTool(def.name, { description: def.name, inputSchema: { symbols: z.string().optional() } }, wrap(async () => ({ content: [{ type: 'text', text: JSON.stringify({ tool: def.name, ok: true }) }] })));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  t.after(() => server.close());
  let id = 0;
  const call = async (name, headers) => (await (await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: {} } }) })).json()).result;
  const key = K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'comp' });
  const H = { 'x-agentfeed-key': key };
  assert.equal((await call('get_recent_liquidations', H)).isError, undefined, 'the first call is admitted');
  const keyRows = rows.filter((x) => x.status === 'key').length;
  const refused = await call('get_recent_liquidations', H);
  assert.equal(refused.isError, true);
  const body = JSON.parse(refused.content[0].text);
  assert.deepEqual([body.status, body.retry_after], [429, 10]);
  assert.match(body.error, /^this day pass answers \/api\/liquidations one call every 10 s per key \(6 a minute\)\. Retry in 10 s\.$/);
  assert.equal(rows.filter((x) => x.status === 'key').length, keyRows, 'a refusal leaves no call row');
  for (let i = 0; i < 3; i++) assert.equal((await call('get_liq_feed', H)).isError, undefined, 'get_liq_feed is not paced by this wrapper');
  clock.t += 10_000;
  assert.equal((await call('get_recent_liquidations', H)).isError, undefined, '10 seconds later: admitted');
  // a prepaid pack key on the same tool, back to back
  const pack = K.store.grant(1, 'pack');
  for (let i = 0; i < 3; i++) assert.equal((await call('get_recent_liquidations', { 'x-agentfeed-key': pack })).isError, undefined);
});

// ---- openapi documents the pass fields /api/keys/balance already returns (patch from MONEY, 19 Oct 2026) ------------------------------------
test('openapi: the /api/keys/balance schema lists every field a pass key gets back, for both kinds of pass, and the status values', async (t) => {
  const D = require('../tools/discovery');
  const api = D.buildOpenApi({ PRICES: {}, TAGS: {}, META: {}, FREE_TOOLS: [], mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' });
  const get = api.paths['/api/keys/balance'].get;
  const schema = get.responses[200].content['application/json'].schema;
  assert.match(get.description, /a pass key also returns pass\.expires_at, pass\.days_left and pass\.hours_left/);
  assert.match(schema.properties.status.description, /active, pending, revoked or expired/);
  assert.deepEqual(schema.properties.pass.properties.kind.enum, ['pass', 'day']);
  const s = await boot(); t.after(s.close);
  for (const [days, allow, kind] of [[1, DAY_PASS.allow, 'day'], [30, PASS.allow, 'pass']]) {
    const key = s.K.store.grantPass({ days, allow, label: `schema-${kind}` });
    const b = await (await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).json();
    assert.equal(b.pass.kind, kind);
    for (const k of Object.keys(b)) assert.ok(k in schema.properties, `top-level ${k} is documented`);
    for (const k of Object.keys(b.pass)) assert.ok(k in schema.properties.pass.properties, `pass.${k} is documented (${kind})`);
    assert.ok(schema.properties.pass.properties.kind.enum.includes(b.pass.kind));
  }
});

// ---- R15d/R15e: gateCaller is who tools/liqfeed.js gates over MCP: the REST rail's own 'key:<prefix>' plus whether it is a pass --------------
test('R15e gateCaller: { key: key:<prefix>, pass } for an active day pass, bot pass and prepaid pack; null for no key, an unknown key and an expired pass', async (t) => {
  const s = await boot(); t.after(s.close);
  const reqOf = async (key) => { const req = { headers: key ? { 'x-agentfeed-key': key } : {}, callerIp: '127.0.0.1', method: 'GET', path: '/x', query: {} }; await new Promise((r) => s.K.identify(req, { set() {}, status() { return this; }, json() { r(); } }, r)); return req; };
  const day = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'd' });
  const bot = s.K.store.grantPass({ days: 30, label: 'b' });
  const pack = s.K.store.grant(1, 'p');
  const pfx = (k) => s.K.store.get(hashKey(k)).prefix;
  assert.deepEqual(s.K.gateCaller(await reqOf(day)), { key: `key:${pfx(day)}`, pass: true });
  assert.deepEqual(s.K.gateCaller(await reqOf(bot)), { key: `key:${pfx(bot)}`, pass: true });
  assert.deepEqual(s.K.gateCaller(await reqOf(pack)), { key: `key:${pfx(pack)}`, pass: false }, 'a prepaid pack is a caller too, on the 5 s clock');
  assert.equal(s.K.gateCaller(await reqOf(null)), null, 'no key');
  assert.equal(s.K.gateCaller(await reqOf('afk_' + '1'.repeat(43))), null, 'an unknown key');
  assert.equal(s.K.gateCaller(undefined), null);
  s.clock.t += DAY;
  assert.equal(s.K.gateCaller(await reqOf(day)), null, 'an expired pass');
  assert.deepEqual(s.K.gateCaller(await reqOf(bot)), { key: `key:${pfx(bot)}`, pass: true }, 'the 30-day pass is still active');
});

test('R15e REST: req.keyPaid.pass is true for a pass key and false for a pack, so liqfeed picks 10 s or 5 s', async (t) => {
  const s = await boot(); t.after(s.close);
  const seen = [];
  s.K.stop();   // (the harness app is already built; a second app below shares the same key store)
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(s.K.identify); app.use(s.K.charge);
  app.get('/api/liq-feed', (req, res) => { seen.push(req.keyPaid && { prefix: req.keyPaid.prefix, pass: req.keyPaid.pass }); res.json({ ok: true }); });
  const srv = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  t.after(() => srv.close());
  const day = s.K.store.grantPass({ days: 1, allow: DAY_PASS.allow, label: 'd' });
  const pack = s.K.store.grant(1, 'p');
  for (const k of [day, pack]) assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/api/liq-feed`, { headers: { 'x-agentfeed-key': k } })).status, 200);
  assert.deepEqual(seen.map((x) => x.pass), [true, false]);
});

