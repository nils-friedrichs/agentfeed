// R9 K1/K2: prepaid keys end to end against the REAL @x402/express 2.28 middleware (its buffering and settle-after-
// handler order is what lib/keys.js relies on) with a stub facilitator, an in-memory SQLite store and the real
// lib/tool.js wrapper. Middleware order is server.js's Phase 2 order: identify, (IP limiter), purchase guard, charge,
// then the x402 gate skipped for req.keyPaid.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { makeKeys, hashKey, newKey, KEY_RE, base58, onSettled } = require('../lib/keys');
const { makeTool } = require('../lib/tool');
const { hfUsd } = require('../lib/hf');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

const PRICES = {
  'GET /api/thing': { usd: 0.01, tool: 'get_thing' },
  'GET /api/cheap': { usd: 0.001, tool: 'get_cheap' },
  'GET /api/p/:id': { usd: 0.004, tool: 'get_p' },
  'GET /api/fail400': { usd: 0.01, tool: 'get_fail400' },
  'GET /api/fail404': { usd: 0.01, tool: 'get_fail404' },
  'GET /api/fail500': { usd: 0.01, tool: 'get_fail500' },
  'GET /api/fail503': { usd: 0.01, tool: 'get_fail503' },
  'GET /api/keys/buy-1': { usd: 1, tool: 'buy_key_1' },
  'GET /api/keys/buy-trial': { usd: 0.25, tool: 'buy_key_trial' },
  'GET /api/keys/topup-5': { usd: 5, tool: 'topup_key_5' },
};

async function boot({ settle = 'ok', paymentsOn = true } = {}) {
  const db = new Database(':memory:');
  const rows = [];
  const logCall = (r) => rows.push(r);
  const fac = {
    calls: { verify: 0, settle: 0 },
    mode: settle,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { this.calls.verify++; return { isValid: true, payer: PAYER }; },
    async settle() {
      this.calls.settle++;
      return this.mode === 'ok' ? { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: PAYER } : { success: false, errorReason: 'insufficient_funds', transaction: '', network: NET, payer: PAYER };
    },
  };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  const routes = {};
  for (const [pattern, p] of Object.entries(PRICES)) routes[pattern] = { accepts: [{ scheme: 'exact', price: `$${p.usd}`, network: NET, payTo: PAYTO }], description: p.tool, mimeType: 'application/json' };
  const gate = paymentMiddleware(routes, rs);
  const K = makeKeys({ db, PRICES, logCall, hfUsd, paymentsOn });
  const gateHits = { n: 0 };

  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.use((req, res, next) => { // HEAD guard stand-in: HEAD on a priced path is a GET with no payment headers
    if (req.method === 'HEAD' && req.path.startsWith('/api/')) { req.method = 'GET'; req.headOnly = true; }
    next();
  });
  app.use(K.purchaseGuard);
  app.use(K.charge);
  app.use((req, res, next) => { if (req.keyPaid) return next(); gateHits.n++; return gate(req, res, next); });
  const { tool } = makeTool({ paymentsOn: true, PRICES, decodeSettlement: (res) => { const raw = res.getHeader('payment-response'); return raw ? unb64(raw) : null; }, logCall });
  const ok = (req) => ({ ok: true, id: req.params.id || null });
  app.get('/api/thing', tool('get_thing', 0.01, ok));
  app.get('/api/cheap', tool('get_cheap', 0.001, ok));
  app.get('/api/p/:id', tool('get_p', 0.004, ok));
  app.get('/api/fail400', tool('get_fail400', 0.01, () => { throw Object.assign(new Error('bad input'), { kind: 'bad_request' }); }));
  app.get('/api/fail404', (_req, res) => res.status(404).json({ error: 'nope' }));
  app.get('/api/fail500', () => { throw new Error('boom'); });
  app.get('/api/fail503', tool('get_fail503', 0.01, () => { throw Object.assign(new Error('stale'), { status: 503 }); }));
  app.get('/api/keys/buy-1', tool('buy_key_1', 1, (req) => K.buy(req.query, req, 1)));
  app.get('/api/keys/buy-trial', tool('buy_key_trial', 0.25, (req) => K.buy(req.query, req, 0.25)));
  app.get('/api/keys/topup-5', tool('topup_key_5', 5, (req) => K.topup(req.query, req, 5)));
  app.get('/api/keys/balance', K.balance);
  app.get('/api/free', (_req, res) => res.json({ free: true }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'internal' })); // eslint-disable-line no-unused-vars
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}, method = 'GET') => fetch(base + p, { headers, method });
  // a real x402 v2 buyer: take the challenge, echo its first accept back as PAYMENT-SIGNATURE
  async function pay(p, headers = {}) {
    const ch = await get(p, headers);
    if (ch.status !== 402) return ch;
    const pr = unb64(ch.headers.get('payment-required'));
    const sig = b64({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: pr.accepts[0].amount, validAfter: '0', validBefore: String(2 ** 40), nonce: '0x' + '00'.repeat(32) } } });
    return get(p, { ...headers, 'payment-signature': sig });
  }
  await new Promise((r) => setTimeout(r, 30)); // let the middleware's facilitator sync settle
  return { db, rows, fac, K, gateHits, get, pay, base, close: () => { K.stop(); server.close(); } };
}

const keyRow = (t, key) => t.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(key));
const flush = () => new Promise((r) => setTimeout(r, 20));

test('key format: afk_ + base58 of 32 random bytes; base58 matches the reference vector', () => {
  const k = newKey();
  assert.match(k, KEY_RE);
  assert.ok(k.length >= 4 + 43 && k.length <= 4 + 44);
  assert.equal(base58(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U'); // the bs58 README vector
  assert.equal(base58(Buffer.from([0, 0, 1])), '112');
});

test('purchase, settle OK: the key arrives once, is active, and only its hash is stored', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.pay('/api/keys/buy-1');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.data.key, KEY_RE);
  assert.equal(body.data.prefix, body.data.key.slice(4, 12));
  const row = keyRow(s, body.data.key);
  assert.equal(row.status, 'active');
  assert.equal(row.balance_micro, 1_000_000);
  assert.equal(row.sold_micro, 1_000_000);
  assert.equal(row.buyer, PAYER);
  assert.match(row.purchase_tx, /^0x5e/);
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM api_keys').all()) + JSON.stringify(s.rows);
  assert.ok(!dump.includes(body.data.key), 'the key is in no row and no calls row');
  await flush();
  const paid = s.rows.filter((x) => x.status === 'paid');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].tool, 'buy_key_1');
  assert.equal(paid[0].amount_usdc, 1);
});

test('purchase, settle FAILED: no key reaches the buyer and no usable row remains', async (t) => {
  const s = await boot({ settle: 'fail' }); t.after(s.close);
  const r = await s.pay('/api/keys/buy-1');
  assert.equal(r.status, 402);
  const text = await r.text();
  assert.ok(!/afk_/.test(text), 'the buffered body with the key was discarded');
  await flush();
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM api_keys').get().n, 0, 'the pending row is deleted on finish');
  assert.equal(s.fac.calls.settle, 1);
});

test('purchase, handler fails: no settlement, no row', async (t) => {
  const s = await boot(); t.after(s.close);
  s.K.store.createPending({ hash: 'a'.repeat(64), prefix: null, creditMicro: 1 }); // the race the guard cannot see
  const ch = await s.get('/api/keys/buy-1?key_hash=' + 'b'.repeat(64));
  assert.equal(ch.status, 402);
  // force a duplicate past the guard by registering the hash between challenge and payment
  const pr = unb64(ch.headers.get('payment-required'));
  s.K.store.createPending({ hash: 'b'.repeat(64), prefix: null, creditMicro: 1 });
  s.db.prepare("UPDATE api_keys SET status='active' WHERE key_hash = ?").run('b'.repeat(64));
  const sig = b64({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0x', authorization: { from: PAYER } } });
  const r = await s.get('/api/keys/buy-1?key_hash=' + 'b'.repeat(64), { 'payment-signature': sig });
  assert.equal(r.status, 409, 'the guard refuses it before verify');
  assert.equal(s.fac.calls.verify, 0);
  assert.equal(s.fac.calls.settle, 0);
});

test('a pending row with no settlement is swept after 10 minutes, a fresh one is kept', async (t) => {
  const s = await boot(); t.after(s.close);
  s.K.store.createPending({ hash: 'c'.repeat(64), prefix: null, creditMicro: 5 });
  s.db.prepare('UPDATE api_keys SET created = created - 601000 WHERE key_hash = ?').run('c'.repeat(64));
  s.K.store.createPending({ hash: 'd'.repeat(64), prefix: null, creditMicro: 5 });
  assert.equal(s.K.store.sweep(), 1);
  assert.ok(s.K.store.get('d'.repeat(64)));
  assert.equal(s.K.store.get('c'.repeat(64)), null);
});

test('key_hash purchase: registers the hash, returns no key, and the client key works on first use', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = newKey();
  const h = crypto.createHash('sha256').update(key).digest('hex');
  const r = await s.pay(`/api/keys/buy-trial?key_hash=${h}&prefix=${key.slice(4, 12)}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.data.key, undefined);
  assert.equal(body.data.prefix, key.slice(4, 12));
  assert.equal(body.data.key_hash_prefix, h.slice(0, 12));
  assert.equal(s.K.store.get(h).status, 'active');
  assert.equal(s.K.store.get(h).balance_micro, 250_000);
  const use = await s.get('/api/thing', { 'x-agentfeed-key': key });
  assert.equal(use.status, 200);
  assert.equal(s.K.store.get(h).balance_micro, 250_000 - 5_000);
});

test('key_hash purchase without prefix: the prefix is learned on first use', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = newKey();
  const h = hashKey(key);
  assert.equal((await s.pay(`/api/keys/buy-trial?key_hash=${h}`)).status, 200);
  assert.equal(s.K.store.get(h).prefix, null);
  assert.equal((await s.get('/api/keys/balance', { 'x-agentfeed-key': key })).status, 200);
  assert.equal(s.K.store.get(h).prefix, key.slice(4, 12));
});

test('duplicate key_hash: 409 before any payment, even with a payment attached', async (t) => {
  const s = await boot(); t.after(s.close);
  const key = newKey();
  assert.equal((await s.pay(`/api/keys/buy-1?key_hash=${hashKey(key)}`)).status, 200);
  const v = s.fac.calls.verify;
  const r = await s.get(`/api/keys/buy-1?key_hash=${hashKey(key)}`, { 'payment-signature': b64({ x402Version: 2 }) });
  assert.equal(r.status, 409);
  assert.equal(r.headers.get('payment-required'), null);
  assert.equal(s.fac.calls.verify, v);
  assert.equal((await s.get('/api/keys/buy-1?key_hash=xyz')).status, 400);
});

test('none, unknown, malformed, pending, revoked, low balance and OK', async (t) => {
  const s = await boot(); t.after(s.close);
  // none: the normal x402 challenge
  const none = await s.get('/api/thing');
  assert.equal(none.status, 402);
  assert.ok(none.headers.get('payment-required'));
  // unknown and malformed: 401 with the buy path, never the x402 layer
  const hits = s.gateHits.n;
  for (const k of [newKey(), 'afk_short', 'afk_' + '0'.repeat(44)]) {
    const r = await s.get('/api/thing', { 'x-agentfeed-key': k });
    assert.equal(r.status, 401, k.slice(0, 8));
    assert.equal(r.headers.get('payment-required'), null);
    assert.equal((await r.json()).buy, '/api/keys/buy-5');
  }
  assert.equal(s.gateHits.n, hits, 'a bad key never reaches x402');
  // pending
  const pk = newKey();
  s.K.store.createPending({ hash: hashKey(pk), prefix: pk.slice(4, 12), creditMicro: 1_000_000 });
  assert.equal((await s.get('/api/thing', { 'x-agentfeed-key': pk })).status, 401);
  // revoked
  const rk = s.K.store.grant(1, 'test');
  s.K.store.setStatus(hashKey(rk), 'revoked');
  assert.equal((await s.get('/api/thing', { 'x-agentfeed-key': rk })).status, 401);
  // low balance: 402 JSON, not an x402 challenge
  const lk = s.K.store.grant(0.004, 'low');
  const low = await s.get('/api/thing', { 'x-agentfeed-key': lk });
  assert.equal(low.status, 402);
  assert.equal(low.headers.get('payment-required'), null);
  assert.deepEqual(await low.json(), { error: 'key balance too low', balance_usd: 0.004, price_usd: 0.005, topup: '/api/keys/topup-5' });
  // OK, both header forms; path-parameter routes resolve; the price is hfUsd
  const k = s.K.store.grant(1, 'ok');
  const a = await s.get('/api/thing', { 'x-agentfeed-key': k });
  assert.equal(a.status, 200);
  assert.equal((await a.json()).paid, true);
  assert.equal((await s.get('/api/p/xyz', { authorization: `Bearer ${k}` })).status, 200);
  assert.equal((await s.get('/api/cheap', { 'x-agentfeed-key': k })).status, 200);
  await flush();
  const row = keyRow(s, k);
  assert.equal(row.balance_micro, 1_000_000 - 5_000 - 2_000 - 500);
  assert.equal(row.spent_micro, 7_500);
  assert.equal(row.calls, 3);
  const keyRows = s.rows.filter((x) => x.status === 'key');
  assert.deepEqual(keyRows.map((x) => [x.tool, x.amount_usdc, x.payer_wallet, x.tx_sig]), [
    ['get_thing', 0.005, `key:${k.slice(4, 12)}`, null], ['get_p', 0.002, `key:${k.slice(4, 12)}`, null], ['get_cheap', 0.0005, `key:${k.slice(4, 12)}`, null]]);
  assert.ok(!JSON.stringify(s.rows).includes(k), 'the key is in no calls row');
});

test('20 concurrent calls on a balance that covers 7: exactly 7 served, 13 get 402', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(0.035, 'conc'); // 7 x $0.005
  const rs = await Promise.all(Array.from({ length: 20 }, () => s.get('/api/thing', { 'x-agentfeed-key': k })));
  const codes = rs.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, 7);
  assert.equal(codes.filter((c) => c === 402).length, 13);
  await flush();
  const row = keyRow(s, k);
  assert.equal(row.balance_micro, 0);
  assert.equal(row.calls, 7);
  assert.equal(s.rows.filter((x) => x.status === 'key').length, 7);
});

test('refund on 400, 404, 500 and 503: never billed, never counted', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(1, 'refund');
  for (const [p, code] of [['/api/fail400', 400], ['/api/fail404', 404], ['/api/fail500', 500], ['/api/fail503', 503]]) {
    const r = await s.get(p, { 'x-agentfeed-key': k });
    assert.equal(r.status, code, p);
  }
  await flush();
  const row = keyRow(s, k);
  assert.equal(row.balance_micro, 1_000_000);
  assert.equal(row.calls, 0);
  assert.equal(row.spent_micro, 0);
  assert.equal(s.rows.filter((x) => x.status === 'key').length, 0);
});

test('top-up: adds only after settlement; a failed settlement adds nothing; needs a known key', async (t) => {
  const s = await boot({ settle: 'fail' }); t.after(s.close);
  const k = s.K.store.grant(0.5, 'topup');
  assert.equal((await s.pay('/api/keys/topup-5', { 'x-agentfeed-key': k })).status, 402);
  await flush();
  assert.equal(keyRow(s, k).balance_micro, 500_000, 'failed settlement: unchanged');
  s.fac.mode = 'ok';
  const r = await s.pay('/api/keys/topup-5', { 'x-agentfeed-key': k });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).data.balance_usd, 5.5);
  assert.equal(keyRow(s, k).balance_micro, 5_500_000);
  assert.equal(keyRow(s, k).sold_micro, 5_000_000);
  // an unknown key is refused before any payment; no key and no payment gets the plain 402 challenge (a crawler or validator must
  // see a priced route), and no key WITH a payment is refused before it can settle
  const v = s.fac.calls.verify;
  assert.equal((await s.get('/api/keys/topup-5', { 'x-agentfeed-key': newKey() })).status, 401);
  assert.equal((await s.get('/api/keys/topup-5')).status, 402, 'unpaid, no key: the challenge, so validators and crawlers see a priced route');
  assert.equal(s.fac.calls.verify, v, 'still nothing verified');
  const ch = await s.get('/api/keys/topup-5');
  const pr = unb64(ch.headers.get('payment-required'));
  const sig = b64({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: pr.accepts[0].amount, validAfter: '0', validBefore: '9999999999', nonce: '0x' + '22'.repeat(32) } } });
  const st = s.fac.calls.settle;
  const noKeyPaid = await s.get('/api/keys/topup-5', { 'payment-signature': sig });
  assert.equal(noKeyPaid.status, 401, 'a payment without the key is refused before it can settle');
  assert.equal(s.fac.calls.verify, v, 'and nothing reached the facilitator');
  assert.equal(s.fac.calls.settle, st, 'and nothing settled');
});

test('a key cannot pay for a key: buy and top-up routes are never charged to a balance', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(30, 'launder');
  const r = await s.get('/api/keys/buy-1', { 'x-agentfeed-key': k });
  assert.equal(r.status, 402);
  assert.ok(r.headers.get('payment-required'), 'the x402 challenge, not a key charge');
  assert.equal(keyRow(s, k).balance_micro, 30_000_000);
});

test('per-key rate limit: rate_per_min, 429 with Retry-After, its own bucket', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(1, 'rate');
  s.K.store.setRate(hashKey(k), 3);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.get('/api/thing', { 'x-agentfeed-key': k })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const other = s.K.store.grant(1, 'other');
  assert.equal((await s.get('/api/thing', { 'x-agentfeed-key': other })).status, 200, 'another key is not throttled');
  await flush();
  assert.equal(keyRow(s, k).calls, 3);
  assert.equal(s.rows.filter((x) => x.tool === 'rate_limited').length, 1, 'logged once per window');
});

test('balance: free; 401 for none and unknown; shows status, never the key', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.equal((await s.get('/api/keys/balance')).status, 401);
  assert.equal((await s.get('/api/keys/balance', { 'x-agentfeed-key': newKey() })).status, 401);
  const k = s.K.store.grant(0.05, 'bal');
  await s.get('/api/thing', { 'x-agentfeed-key': k });
  await flush();
  const balRes = await s.get('/api/keys/balance', { 'x-agentfeed-key': k });
  assert.equal(balRes.headers.get('cache-control'), 'no-store', 'an account answer is never cached');
  const b = await balRes.json();
  assert.deepEqual(Object.keys(b).sort(), ['balance_usd', 'calls', 'last_used', 'prefix', 'rate_per_min', 'spent_usd', 'status']);
  assert.equal(b.balance_usd, 0.045);
  assert.equal(b.spent_usd, 0.005);
  assert.equal(b.calls, 1);
  assert.equal(b.status, 'active');
  assert.equal(b.prefix, k.slice(4, 12));
});

test('HEAD with a key is never charged; a key on a free route is ignored', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(1, 'head');
  const h = await s.get('/api/thing', { 'x-agentfeed-key': k }, 'HEAD');
  assert.equal(h.status, 402);
  assert.equal((await s.get('/api/free', { 'x-agentfeed-key': k })).status, 200);
  await flush();
  assert.equal(keyRow(s, k).balance_micro, 1_000_000);
});

test('the key header is removed before later middleware; Authorization: Payment is left alone', async () => {
  const k = newKey();
  const db = new Database(':memory:');
  const K = makeKeys({ db, PRICES, logCall: () => {}, hfUsd });
  const req = { headers: { 'x-agentfeed-key': k }, method: 'GET', path: '/api/thing' };
  K.identify(req, {}, () => {});
  assert.equal(req.headers['x-agentfeed-key'], undefined);
  const req2 = { headers: { authorization: `Bearer ${k}` }, method: 'GET', path: '/api/thing' };
  K.identify(req2, {}, () => {});
  assert.equal(req2.headers.authorization, undefined);
  const req3 = { headers: { authorization: 'Payment eyJ4In0=' }, method: 'GET', path: '/api/thing' };
  K.identify(req3, {}, () => {});
  assert.equal(req3.headers.authorization, 'Payment eyJ4In0=');
  assert.equal(req3.afKey, undefined);
  K.stop();
});

test('onSettled: fires once on a success header or an MPP settlement, never on a failure header', () => {
  const mk = () => { const h = {}; return { setHeader(n, v) { h[n.toLowerCase()] = v; }, h }; };
  let n = 0;
  const res = mk(); const req = {};
  onSettled(req, res, () => n++);
  res.setHeader('PAYMENT-RESPONSE', b64({ success: false }));
  assert.equal(n, 0);
  res.setHeader('PAYMENT-RESPONSE', b64({ success: true, payer: 'x' }));
  res.setHeader('X-PAYMENT-RESPONSE', b64({ success: true, payer: 'x' }));
  assert.equal(n, 1);
  let m = 0;
  const req2 = {};
  onSettled(req2, mk(), (s) => { m++; assert.equal(s.payer, '0xfeed'); });
  req2.mppSettlement = { payer: '0xfeed', transaction: '0x1', method: 'tempo' };
  assert.equal(m, 1);
  assert.equal(req2.mppSettlement.transaction, '0x1');
});

test('payments off: key sales refuse with 503 before anything else', async (t) => {
  const s = await boot({ paymentsOn: false }); t.after(s.close);
  assert.equal((await s.get('/api/keys/buy-1')).status, 503);
});
