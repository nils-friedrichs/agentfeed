// 15 Oct 2026, #93 + #94.
//   #93: a PDF with no text layer is a 400 (bad_request) and is never settled or charged; a text PDF still converts and is billed,
//        and an unreachable URL / a non-PDF behave as before. Run end to end through the REAL @x402/express 2.28 middleware (stub
//        facilitator, so settle calls can be counted), the prepaid-key rail and the real lib/tool.js wrapper. Only the network
//        fetch (lib/safe-fetch.js) is stubbed; the PDF parse is the real unpdf child process.
//   #94: a call paid with a prepaid key now records user_agent and req_path on its 'key' row.
//   item 3 (15 Oct, round 2): a call paid over x402 records them on its 'paid' row the same way (path as asked, no query).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');

// stub the fetch BEFORE tools/webmd.js destructures it
const SF = require('../lib/safe-fetch');
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });

function makePdf(content) {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const TEXT_PDF = makePdf('BT /F1 18 Tf 20 100 Td (Hello AgentFeed) Tj ET');
const SCAN_PDF = makePdf('0.5 g 20 20 160 160 re f'); // a filled square and no text operators: what an image-only scan looks like to the parser

const SERVED = {
  'https://docs.test/text.pdf': () => ({ body: TEXT_PDF, url: 'https://docs.test/text.pdf' }),
  'https://docs.test/scan.pdf': () => ({ body: SCAN_PDF, url: 'https://docs.test/scan.pdf' }),
  'https://docs.test/notpdf.pdf': () => ({ body: Buffer.from('<html>not a pdf</html>'), url: 'https://docs.test/notpdf.pdf' }),
  'https://docs.test/down.pdf': () => { throw unavailable('could not reach docs.test'); },
  'https://docs.test/blocked.pdf': () => { throw bad('url resolves to a private address'); },
};
SF.safeFetch = async (url) => { const f = SERVED[url]; if (!f) throw unavailable('no robots.txt'); return f(); };
const WM = require('../tools/webmd');
const { makeKeys } = require('../lib/keys');
const { makeTool } = require('../lib/tool');
const { hfUsd } = require('../lib/hf');
const compat = require('../lib/compat');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const PRICES = {
  'GET /api/pdf-markdown': { usd: 0.01, tool: 'get_pdf_markdown' },
  'GET /api/thing': { usd: 0.01, tool: 'get_thing' },
  'GET /api/p/:id': { usd: 0.01, tool: 'get_p' },
};

async function boot() {
  const db = new Database(':memory:');
  const rows = [];
  const logCall = (r) => rows.push(r);
  const fac = {
    calls: { verify: 0, settle: 0 },
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { this.calls.verify++; return { isValid: true, payer: PAYER }; },
    async settle() { this.calls.settle++; return { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: PAYER }; },
  };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  const routes = {};
  for (const [pattern, p] of Object.entries(PRICES)) routes[pattern] = { accepts: [{ scheme: 'exact', price: `$${p.usd}`, network: NET, payTo: PAYTO }], description: p.tool, mimeType: 'application/json' };
  const gate = paymentMiddleware(routes, rs);
  const K = makeKeys({ db, PRICES, logCall, hfUsd, paymentsOn: true });
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.use(K.purchaseGuard);
  app.use(K.charge);
  app.use(compat.stripNetworkSuffix); // the real |network suffix handler, as in server.js
  app.use((req, _res, next) => { // the shape of server.js's query alias: /api/p?id=x is routed as /api/p/x
    if (req.method === 'GET' && req.path === '/api/p' && typeof req.query.id === 'string') req.url = `/api/p/${encodeURIComponent(req.query.id)}`;
    next();
  });
  app.use((req, res, next) => { if (req.keyPaid) return next(); return gate(req, res, next); });
  const { tool } = makeTool({ paymentsOn: true, PRICES, decodeSettlement: (res) => { const raw = res.getHeader('payment-response'); return raw ? unb64(raw) : null; }, logCall });
  app.get('/api/pdf-markdown', tool('get_pdf_markdown', 0.01, (req) => WM.getPdfMarkdown(req.query))); // the same call expansion.js makes
  app.get('/api/thing', tool('get_thing', 0.01, () => ({ ok: true })));
  app.get('/api/p/:id', tool('get_p', 0.01, (req) => ({ id: req.params.id })));
  app.get('/api/freebie', tool('get_freebie', 0, () => ({ free: true })));
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
  await new Promise((r) => setTimeout(r, 30)); // let the middleware's facilitator sync settle
  return { db, rows, fac, K, get, pay, close: () => { K.stop(); server.close(); } };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const enc = encodeURIComponent;

test('the stand-in text PDF is parsed by the real unpdf child process', async () => {
  const t = await WM.getPdfMarkdown({ url: 'https://docs.test/text.pdf' });
  assert.equal(t.pages, 1);
  assert.match(t.markdown, /Hello AgentFeed/);
  assert.ok(t.word_count >= 2);
});

test('#93 getPdfMarkdown: a PDF with no text layer is a bad_request, a text PDF is unchanged', async () => {
  await assert.rejects(() => WM.getPdfMarkdown({ url: 'https://docs.test/scan.pdf' }), (e) => e.kind === 'bad_request' && /no text layer/.test(e.message) && e.status === undefined);
  const ok = await WM.getPdfMarkdown({ url: 'https://docs.test/text.pdf' });
  assert.deepEqual(Object.keys(ok).sort(), ['bytes', 'fetched_at', 'final_url', 'markdown', 'pages', 'rights', 'title', 'truncated', 'url', 'word_count']);
});

test('#93 the other failures are exactly as before: unreachable URL -> 503, blocked URL -> bad_request, non-PDF -> bad_request', async () => {
  await assert.rejects(() => WM.getPdfMarkdown({ url: 'https://docs.test/down.pdf' }), (e) => e.status === 503 && e.kind === undefined && /could not reach/.test(e.message));
  await assert.rejects(() => WM.getPdfMarkdown({ url: 'https://docs.test/blocked.pdf' }), (e) => e.kind === 'bad_request' && /private address/.test(e.message));
  await assert.rejects(() => WM.getPdfMarkdown({ url: 'https://docs.test/notpdf.pdf' }), (e) => e.kind === 'bad_request' && /not a PDF/.test(e.message));
});

test('#93 x402 rail: a text PDF settles once; a no-text PDF is a 400 JSON error and NO settlement; an unreachable URL is a 503 and no settlement', async (t) => {
  const s = await boot(); t.after(s.close);
  const okR = await s.pay(`/api/pdf-markdown?url=${enc('https://docs.test/text.pdf')}`);
  assert.equal(okR.status, 200);
  assert.match((await okR.json()).data.markdown, /Hello AgentFeed/);
  assert.equal(s.fac.calls.settle, 1, 'the text PDF is charged');
  const scanR = await s.pay(`/api/pdf-markdown?url=${enc('https://docs.test/scan.pdf')}`);
  assert.equal(scanR.status, 400);
  const body = await scanR.json();
  assert.equal(body.tool, 'get_pdf_markdown');
  assert.match(body.error, /no text layer/);
  assert.equal(s.fac.calls.settle, 1, 'no second settlement for the scan');
  const downR = await s.pay(`/api/pdf-markdown?url=${enc('https://docs.test/down.pdf')}`);
  assert.equal(downR.status, 503);
  assert.equal(s.fac.calls.settle, 1, 'no settlement for an unreachable URL either');
  await flush();
  assert.deepEqual(s.rows.filter((x) => x.status === 'paid').map((x) => x.tool), ['get_pdf_markdown']);
  const br = s.rows.find((x) => x.status === 'bad_request');
  assert.ok(br && br.tool === 'get_pdf_markdown' && /no text layer/.test(br.error_msg), 'the refusal is logged as bad_request');
});

test('#93 key rail: a no-text PDF costs the key nothing; a text PDF costs $0.005', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(1, 'pdf');
  const bal = () => s.K.store.get(require('../lib/keys').hashKey(k)).balance_micro;
  assert.equal(bal(), 1_000_000);
  assert.equal((await s.get(`/api/pdf-markdown?url=${enc('https://docs.test/scan.pdf')}`, { 'x-agentfeed-key': k })).status, 400);
  await flush();
  assert.equal(bal(), 1_000_000, 'refunded in full');
  assert.equal(s.rows.filter((x) => x.status === 'key').length, 0, 'no key row for a refused call');
  assert.equal((await s.get(`/api/pdf-markdown?url=${enc('https://docs.test/text.pdf')}`, { 'x-agentfeed-key': k })).status, 200);
  await flush();
  assert.equal(bal(), 1_000_000 - 5_000);
  assert.equal(s.rows.filter((x) => x.status === 'key').length, 1);
});

test('#94 key rail: the calls row records user_agent and req_path (path only, no query), and the key itself appears nowhere', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(1, 'telemetry');
  assert.equal((await s.get('/api/thing?x=secret-query', { 'x-agentfeed-key': k, 'user-agent': 'agent-under-test/9.9 (+https://example.test)' })).status, 200);
  assert.equal((await s.get('/api/thing', { authorization: `Bearer ${k}` })).status, 200); // no explicit UA: node's fetch sends its own, so just assert it is a string or null
  await flush();
  const keyRows = s.rows.filter((x) => x.status === 'key');
  assert.equal(keyRows.length, 2);
  assert.equal(keyRows[0].user_agent, 'agent-under-test/9.9 (+https://example.test)');
  assert.equal(keyRows[0].req_path, '/api/thing');
  assert.ok(keyRows[1].user_agent === undefined || typeof keyRows[1].user_agent === 'string');
  assert.equal(keyRows[1].req_path, '/api/thing');
  assert.ok(!JSON.stringify(s.rows).includes(k), 'the key is in no calls row');
  assert.ok(!JSON.stringify(s.rows).includes('secret-query'), 'the query string is not recorded');
});

test('item 3: x402 rail: a paid row records user_agent and req_path (path only, no query); the query string and the payment signature appear in no row', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.pay('/api/thing?token=secret-q', { 'user-agent': 'agent-x402/2.0 (+https://example.test)' });
  assert.equal(r.status, 200);
  await flush();
  const paid = s.rows.filter((x) => x.status === 'paid');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].tool, 'get_thing');
  assert.equal(paid[0].req_path, '/api/thing');
  assert.equal(paid[0].user_agent, 'agent-x402/2.0 (+https://example.test)');
  assert.ok(!JSON.stringify(s.rows).includes('secret-q'), 'the query string is not recorded');
  assert.ok(paid[0].tx_sig && paid[0].payer_wallet, 'the settlement fields are still there');
});

test('item 3: x402 rail: the path is the one asked for, before an alias rewrite; a |network suffix keeps the suffixed path as before', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.equal((await s.pay('/api/p?id=xyz')).status, 200); // routed internally as /api/p/xyz
  assert.equal((await s.pay('/api/thing|eip155:8453')).status, 200);
  await flush();
  const paid = s.rows.filter((x) => x.status === 'paid');
  assert.deepEqual(paid.map((x) => [x.tool, x.req_path]), [['get_p', '/api/p'], ['get_thing', '/api/thing|eip155:8453']]);
});

test('item 3: a free row is unchanged, no user_agent and no req_path', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.equal((await s.get('/api/freebie', { 'user-agent': 'free-caller/1' })).status, 200);
  await flush();
  const free = s.rows.filter((x) => x.status === 'free');
  assert.equal(free.length, 1);
  assert.equal('user_agent' in free[0], false);
  assert.equal('req_path' in free[0], false);
});
