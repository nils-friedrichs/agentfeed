// R19 (21 Oct 2026): regression tests against the REAL server.js, booted in a child process (test/helpers/real-server.js): stub facilitator,
// every outbound connection refused and logged, scratch databases, a counter of route-handler runs.
//
// R19a. An unpaid HEAD ran any paid handler. The HEAD guard decided "priced" with an exact, case-sensitive path match while Express routes
//       case-insensitively and with an optional trailing slash and the x402 gate only matches GET, so HEAD /API/<route> and
//       HEAD /api/<route>/ reached the handler with no payment: Content-Length and ETag of the paid answer went out (a paid answer for free for a
//       route with few possible answers), the handler's upstream calls ran on our money, and a `free` row was written for a priced tool.
//       The sweep below sends 24 spellings of every priced route, GET and HEAD, never with a payment, and asserts four independent things.
// R19b. On the x402 v1 path the logged revenue came from `accepted`, a number the buyer chooses.
// R19c. A UTF-8 BOM in front of the decoded payment JSON: x402 core drops it (TextDecoder), AgentFeed's own decoders threw on it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const H = require('./helpers/real-server');

const MINT = 'So11111111111111111111111111111111111111112';
let s;
let ipN = 0;
const ip = () => { ipN++; return { 'cf-connecting-ip': `198.51.${(ipN >> 8) & 255}.${ipN & 255}` }; };   // one rate-limit bucket per request: the sweep must not be throttled into a false pass
const get = (p, h = {}) => H.raw(s.port, 'GET', p, { ...ip(), ...h });
const send = (m, p, h = {}) => H.raw(s.port, m, p, { ...ip(), ...h });

before(async () => { s = await H.boot(); });
after(() => { if (s) s.close(); });

/** 24 spellings of one path (the reviewer's sweep, generalised): case, slashes, dots, encodings, suffixes, query and fragment shapes. */
function variants(p) {
  const parts = p.split('/');
  const last = parts.pop();
  const dir = parts.join('/');
  return [p, p + '/', p + '//', p.toUpperCase(), p.replace('/api/', '/API/'), p.replace('/api/', '/Api/'), '/' + p, p.replace('/api/', '/api//'),
    dir + '/' + encodeURIComponent(last).replace(/-/g, '%2D'), dir + '/%' + last.charCodeAt(0).toString(16) + last.slice(1), p.replace('/api/', '/api%2F'), p.replace('/api/', '/x/../api/'),
    p.replace('/api/', '/api/./'), '/api/sample/../' + p.slice(5), p + ';x=1', p + '%20', p + '\\', p + '?', p + '#x', p + '%3F', p + '/.', p.replace('/api/', '/%61pi/'), p + '|eip155:8453/', p + '%7Ceip155:1'];
}
const concrete = (tpl) => tpl.replace(/\{doi\}/g, '10.1%2Fx').replace(/\{mint\}/g, MINT).replace(/\{[a-z_]+\}/gi, 'x');

async function routes() {
  const spec = JSON.parse((await get('/openapi.json')).body);
  const priced = [], free = [];
  for (const [p, o] of Object.entries(spec.paths)) {
    if (!o.get || !p.startsWith('/api/')) continue;
    (o.get['x-payment-info'] ? priced : free).push({ tpl: p, path: concrete(p), tool: o.get.operationId });
  }
  return { priced, free };
}

test('R19a: unpaid GET and HEAD on 24 spellings of every priced route are never served: no 2xx, no handler run, no outbound attempt, no free row', async () => {
  const { priced, free } = await routes();
  assert.ok(priced.length >= 80, `control: the sweep covers the real route table (${priced.length} priced routes)`);
  assert.ok(free.length >= 3, 'control: and the free routes are known');
  // controls: the exact path is answered with the 402 challenge on both verbs, so the sweep below can fail
  for (const m of ['GET', 'HEAD']) {
    const r = await send(m, '/api/time');
    assert.equal(r.status, 402, `control: unpaid ${m} /api/time`);
    assert.ok(r.headers['payment-required'], `control: ${m} carries the challenge`);
  }
  assert.deepEqual(s.handlerRuns(), [], 'control: the exact-path controls ran no handler');

  const served = [];
  const jobs = [];
  for (const r of priced) for (const v of variants(r.path)) for (const m of ['GET', 'HEAD']) jobs.push([m, v, r.tool]);
  assert.ok(jobs.length >= priced.length * 24 * 2);
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const [m, v, tool] = jobs[i++];
      let res;
      try { res = await send(m, v); } catch (e) { res = { status: 'ERR ' + e.message }; }
      if (typeof res.status === 'number' && res.status >= 200 && res.status < 400) served.push(`${m} ${v} -> ${res.status} (${tool})`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  assert.deepEqual(served, [], 'unpaid requests served on a priced route');
  assert.deepEqual(s.handlerRuns(), [], 'no route handler ran for an unpaid request');
  assert.deepEqual(s.netAttempts(), [], 'no outbound attempt: an unpaid request started no upstream work');
  const pricedTools = new Set(priced.map((r) => r.tool));
  const rows = (await H.rowsSince(s, 0)).filter((r) => pricedTools.has(r.tool) && ['free', 'paid', 'key', 'bad_request', 'error'].includes(r.status));
  assert.deepEqual(rows.map((r) => [r.tool, r.status]), [], 'no calls row for a priced tool: a handler never ran');

  // the counter is alive and the control is real: a PAID GET on the exact path runs exactly one handler
  const ch = await get('/api/time');
  const paid = await get('/api/time', { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
  assert.equal(paid.status, 200, 'control: a paid GET is served');
  assert.deepEqual(s.handlerRuns(), ['get_time'], 'control: the counter counts the paid call, and only it');
});

test('R19a: a HEAD on a free /api route is still answered like a GET with no body; a HEAD on a priced route is the plain 402 on any spelling', async () => {
  const { free } = await routes();
  let ok = null;
  for (const r of free) { const g = await get(r.path); if (g.status === 200) { ok = r; break; } }
  assert.ok(ok, 'control: some free route answers 200 here');
  for (const spelling of [ok.path, ok.path.replace('/api/', '/API/'), ok.path + '/']) {
    const h = await send('HEAD', spelling);
    assert.equal(h.status, 200, `HEAD ${spelling}`);
    assert.equal(h.body, '', 'no body');
  }
  const head = await send('HEAD', '/API/TIME/');
  assert.equal(head.status, 402);
  assert.ok(head.headers['payment-required'], 'the quote is in the header');
});

test('R19a: a HEAD that carries a payment (any header, any spelling) is never verified or settled: it is the plain challenge, no handler, no facilitator call', async () => {
  const ch = await get('/api/time');
  const sig = H.b64(H.payBase(ch.headers['payment-required']));
  const ran = s.handlerRuns().length;
  s.fac.log.length = 0;
  for (const p of ['/api/time', '/API/TIME/', '/Api/Time']) {
    for (const [label, h] of [['PAYMENT-SIGNATURE', { 'payment-signature': sig }], ['X-PAYMENT v1', { 'x-payment': H.b64(H.payV1()) }], ['Authorization: Payment', { authorization: 'Payment ' + sig }]]) {
      const r = await send('HEAD', p, h);
      assert.equal(r.status, 402, `HEAD ${p} with ${label}`);
    }
  }
  assert.deepEqual(s.fac.log, [], 'the facilitator was never asked to verify or settle for a HEAD');
  assert.equal(s.handlerRuns().length, ran, 'no handler ran');
});

test('R19a: an x402 v1 payment on a case or trailing-slash spelling of a priced route is paid like on the exact path (one canonical path for every rail)', async () => {
  for (const p of ['/api/time', '/API/TIME', '/api/time/']) {
    s.fac.log.length = 0;
    const r = await get(p, { 'x-payment': H.b64(H.payV1()) });
    assert.equal(r.status, 200, `v1 on ${p}`);
    assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle').map((x) => x.amount), ['5000'], `${p}: one settlement of the route price`);
  }
});

test('R19a: the query alias (/api/token-risk?mint=X) is taken on a case or trailing-slash spelling of its base too: an unpaid request is the plain challenge, the handler never runs', async () => {
  const MINT_ = 'So11111111111111111111111111111111111111112';
  const ran = s.handlerRuns().length;   // earlier tests in this file ran paid handlers on purpose: compare, do not expect empty
  for (const p of ['/api/token-risk?mint=' + MINT_, '/API/TOKEN-RISK?mint=' + MINT_, '/Api/Token-Risk/?mint=' + MINT_, '/api/token-risk/?mint=' + MINT_]) {
    for (const m of ['GET', 'HEAD']) {
      const r = await send(m, p);
      assert.equal(r.status, 402, `${m} ${p}`);
      assert.ok(r.headers['payment-required'], `${m} ${p}: the quote is in the header`);
    }
  }
  assert.equal(s.handlerRuns().length, ran, 'no handler ran');
});

test('R19a: the rate limiter files an unpaid GET and a HEAD on any spelling of a priced route in the unpaid and other classes, not in the 240/min metered class', async () => {
  const one = { 'cf-connecting-ip': '203.0.113.99' };   // one address for the whole test: one set of buckets
  // control: the metered class does throttle here. 241 GETs of an unknown /api path (a cheap 404) from one address end in a 429 on the 241st.
  const ctl = { 'cf-connecting-ip': '203.0.113.98' };
  let lastCtl = 0;
  for (let i = 0; i < 241; i++) lastCtl = (await H.raw(s.port, 'GET', '/api/zzz-not-a-route', ctl)).status;
  assert.equal(lastCtl, 429, 'control: the 241st request of the metered class is throttled');
  for (const m of ['GET', 'HEAD']) {
    let bad = null;
    for (let i = 0; i < 260; i++) {
      const r = await H.raw(s.port, m, i % 2 ? '/API/TIME/' : '/Api/Time', one);
      if (r.status !== 402) { bad = [i, r.status]; break; }
    }
    assert.equal(bad, null, `${m} on a spelling of a priced route: 260 requests, all the plain challenge, none in the metered class (index, status of the first other answer)`);
  }
});

test('R19b: the logged revenue of an x402 v1 payment is the requirement this server built, never the buyer\'s `accepted`', async () => {
  const cases = [['plain v1', {}], ['v1 + accepted.amount "1"', { accepted: { amount: '1' } }], ['v1 + accepted.amount "999999999"', { accepted: { amount: '999999999' } }]];
  const before = (await H.rowsSince(s, 0)).length;
  for (const [, extra] of cases) {
    const r = await get('/api/time', { 'x-payment': H.b64(H.payV1(extra)) });
    assert.equal(r.status, 200);
  }
  const rows = (await H.rowsSince(s, 0)).slice(before).filter((r) => r.tool === 'get_time');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.status), ['paid', 'paid', 'paid']);
  assert.deepEqual(rows.map((r) => r.amount_usdc), [0.005, 0.005, 0.005], 'list price in all three, whatever `accepted` says');
});

test('R19b: x402 v2 is unchanged: the logged amount is the matched requirement, which core matched against the offered ones', async () => {
  const before = (await H.rowsSince(s, 0)).length;
  const ch = await get('/api/time');
  s.fac.log.length = 0;
  const r = await get('/api/time', { 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
  assert.equal(r.status, 200);
  assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle').map((x) => x.amount), ['5000']);
  const rows = (await H.rowsSince(s, 0)).slice(before).filter((r2) => r2.tool === 'get_time');
  assert.deepEqual(rows.map((r2) => [r2.status, r2.amount_usdc]), [['paid', 0.005]]);
});

test('R19c: a UTF-8 BOM in front of the payment JSON is read the way x402 reads it: PAYMENT-SIGNATURE and X-PAYMENT both settle', async () => {
  const bom = (o) => Buffer.from('﻿' + JSON.stringify(o)).toString('base64');
  const ch = await get('/api/time');
  const pay = H.payBase(ch.headers['payment-required']);
  for (const [label, headers] of [['PAYMENT-SIGNATURE: BOM', { 'payment-signature': bom(pay) }], ['X-PAYMENT: BOM v2 payload', { 'x-payment': bom(pay) }]]) {
    s.fac.log.length = 0;
    const r = await get('/api/time', headers);
    assert.equal(r.status, 200, label);
    assert.deepEqual(s.fac.log.filter((x) => x.op === 'settle').map((x) => x.amount), ['5000'], label);
  }
});

