'use strict';
// R2: route|network paths, GET /mcp 405, Bazaar-shape discovery, agent card, sharp-move 410,
// token-holders refuses mints Helius cannot rank before any upstream call.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const compat = require('../lib/compat');

async function call(t, app, p) {
  const srv = app.listen(0); t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`);
  return { r, body: await r.json().catch(() => null) };
}
function echoApp() {
  const app = express();
  app.use(compat.stripNetworkSuffix);
  app.get('/api/options-summary', (req, res) => res.json({ url: req.url, originalUrl: req.originalUrl, orig: req.x402OriginalPath || null, q: req.query }));
  return app;
}

test('route|network suffix: raw, %7C and %7c, eip155 and solana, query kept, original remembered', async (t) => {
  for (const p of ['/api/options-summary|eip155:42161', '/api/options-summary%7Ceip155:8453', '/api/options-summary%7csolana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']) {
    const { r, body } = await call(t, echoApp(), p + '?currency=ETH');
    assert.equal(r.status, 200, p);
    assert.equal(body.url, '/api/options-summary?currency=ETH');
    assert.equal(body.originalUrl, '/api/options-summary?currency=ETH', 'the challenge resource URL is the clean one');
    assert.equal(body.q.currency, 'ETH');
    assert.ok(body.orig && body.orig.startsWith('/api/options-summary'), 'original kept for the rows');
  }
  const { r } = await call(t, echoApp(), '/api/options-summary%7Cfoo:1');
  assert.equal(r.status, 404, 'an unknown suffix is not stripped');
  const { r: r2 } = await call(t, echoApp(), '/other/x%7Ceip155:1');
  assert.equal(r2.status, 404, 'only /api/ paths');
});

test('GET /mcp answers 405 with Allow: POST', async (t) => {
  const app = express(); app.get('/mcp', compat.mcpGet405);
  const { r } = await call(t, app, '/mcp');
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST');
});

test('discovery: CDP Bazaar shape from the layer, paginated; 503 until the layer exists', async (t) => {
  let layer = null;
  const app = express();
  const h = compat.makeDiscovery({ getLayer: () => layer, concreteUrl: (p) => 'https://x' + p.replace('GET ', '') });
  for (const p of compat.DISCOVERY_PATHS) app.get(p, h);
  assert.equal((await call(t, app, '/discovery/resources')).r.status, 503);
  layer = {
    routes: {
      'GET /api/a': { accepts: [{ scheme: 'exact', network: 'n1', price: '$0.001', payTo: 'P' }, { scheme: 'exact', network: 'n2', price: '$0.001', payTo: 'Q' }], description: 'A', serviceName: 'AgentFeed', tags: ['t'], iconUrl: 'i', mimeType: 'application/json', extensions: { bazaar: {} } },
      'GET /api/b': { accepts: [{ scheme: 'exact', network: 'n1', price: '$0.02', payTo: 'P' }], description: 'B', serviceName: 'AgentFeed', tags: [], iconUrl: 'i', mimeType: 'application/json' },
    },
    resourceServer: { buildPaymentRequirements: async (a) => [{ scheme: a.scheme, network: a.network, amount: a.price === '$0.001' ? '1000' : '20000', asset: 'USDC', payTo: a.payTo, maxTimeoutSeconds: 300, extra: {} }] },
  };
  for (const p of compat.DISCOVERY_PATHS) {
    const { r, body } = await call(t, app, p + '?limit=1&offset=1');
    assert.equal(r.status, 200, p);
    assert.equal(body.x402Version, 2);
    assert.deepStrictEqual(body.pagination, { limit: 1, offset: 1, total: 2 });
    assert.equal(body.items[0].resource, 'https://x/api/b');
    assert.equal(body.items[0].accepts[0].amount, '20000');
    assert.equal(body.items[0].type, 'http');
  }
  const { body } = await call(t, app, '/v2/x402/discovery/resources');
  assert.equal(body.items[0].accepts.length, 2);
});

test('agent card: one skill per paid tool, x402 pointer', async (t) => {
  const PRICES = { 'GET /api/price': { tool: 'get_spot', usd: 0.001, desc: 'Spot.' }, 'GET /api/perp': { tool: 'get_perp', usd: 0.005, desc: 'Perp.' } };
  const app = express();
  app.get('/.well-known/agent-card.json', compat.makeAgentCard({ PRICES, TAGS: { get_spot: ['price'] }, TITLES: { get_spot: 'Spot price' }, questionFor: (t) => (t === 'get_spot' ? 'What is SOL at?' : null), version: '9.9.9', ORIGIN: 'https://x', railNames: () => 'Solana', mpp: { active: true, routes: ['GET /api/sol-price'] } }));
  const { r, body } = await call(t, app, '/.well-known/agent-card.json');
  assert.equal(r.status, 200);
  assert.equal(body.name, 'AgentFeed');
  assert.equal(body.version, '9.9.9');
  assert.equal(body.skills.length, 2);
  assert.deepStrictEqual(body.skills[0].examples, ['What is SOL at?']);
  assert.equal(body.capabilities.extensions[0].params.discovery, 'https://x/.well-known/x402.json');
});

test('/api/sharp-move is 410 Gone with the closest live routes', async (t) => {
  const PRICES = { 'GET /api/oi-spike-scan': { tool: 'get_oi_spike_scan', usd: 0.02, desc: 'Abnormal OI jumps. More.' }, 'GET /api/top-movers': { tool: 'get_top_movers', usd: 0.01, desc: 'Movers.' } };
  const app = express(); app.get('/api/sharp-move', compat.makeSharpMoveGone({ PRICES, ORIGIN: 'https://x' }));
  const { r, body } = await call(t, app, '/api/sharp-move');
  assert.equal(r.status, 410);
  assert.deepStrictEqual(body.closest_live.map((c) => c.tool), ['get_oi_spike_scan', 'get_top_movers']);
  assert.equal(body.closest_live[0].what, 'Abnormal OI jumps.');
});

test('token-holders: known-large mints refused before any upstream call; a new one is learned', async () => {
  const file = path.join(os.tmpdir(), `large-mints-${process.pid}.json`);
  process.env.LARGE_MINTS_FILE = file;
  process.env.HELIUS_RPC = 'http://127.0.0.1:9/never';
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body.method);
    const j = body.method === 'getTokenLargestAccounts'
      ? { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Too many accounts requested (10000000 pubkeys), try adding filters to narrow down results' } }
      : { jsonrpc: '2.0', id: 1, result: { token_info: { decimals: 6, supply: 1 } } };
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    delete require.cache[require.resolve('../tools/solana2')];
    const S = require('../tools/solana2');
    await assert.rejects(S.getTokenHolders({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }), (e) => e.kind === 'bad_request' && /10,000,000-account limit/.test(e.message));
    assert.equal(calls.length, 0, 'no upstream call for a seeded mint');
    const big = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    await assert.rejects(S.getTokenHolders({ mint: big }), (e) => e.kind === 'bad_request' && /too many token accounts/.test(e.message));
    assert.ok(S._LARGE_MINTS.has(big), 'learned');
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).includes(big), 'persisted');
    const before = calls.length;
    await assert.rejects(S.getTokenHolders({ mint: big }), (e) => e.kind === 'bad_request');
    assert.equal(calls.length, before, 'second time: no upstream call');
  } finally {
    global.fetch = realFetch; try { fs.unlinkSync(file); } catch { /* none */ }
    delete process.env.LARGE_MINTS_FILE; delete process.env.HELIUS_RPC;
  }
});

test('paid routes are GET-only: POST is a JSON 405 with Allow: GET; GET and unpriced POST untouched', async (t) => {
  const app = express();
  app.use(compat.makeGetOnly({ PRICES: { 'GET /api/equity-24h': { tool: 'e' }, 'GET /api/token-risk/:mint': { tool: 'r' } } }));
  app.all('*', (req, res) => res.json({ passed: req.method }));
  const srv = app.listen(0); t.after(() => srv.close()); const u = `http://127.0.0.1:${srv.address().port}`;
  const p1 = await fetch(`${u}/api/equity-24h`, { method: 'POST' });
  assert.equal(p1.status, 405); assert.equal(p1.headers.get('allow'), 'GET'); assert.match((await p1.json()).error, /paid routes are GET/);
  assert.equal((await fetch(`${u}/api/token-risk/So1111`, { method: 'PUT' })).status, 405);
  assert.equal((await (await fetch(`${u}/api/equity-24h`)).json()).passed, 'GET');
  assert.equal((await (await fetch(`${u}/mcp`, { method: 'POST' })).json()).passed, 'POST');
});

test('/pricing JSON by default and HTML for browsers; /terms plain text', async (t) => {
  const app = express();
  app.get('/pricing', compat.makePricing({ PRICES: { 'GET /api/perp': { tool: 'get_perp', usd: 0.005 }, 'GET /api/price': { tool: 'get_spot', usd: 0.001 } }, FREE_TOOLS: ['get_fear_greed'], ORIGIN: 'https://x', railNames: () => 'Solana', mpp: { active: false, routes: [] } }));
  app.get('/terms', compat.termsHandler);
  const srv = app.listen(0); t.after(() => srv.close()); const u = `http://127.0.0.1:${srv.address().port}`;
  const j = await (await fetch(`${u}/pricing`)).json();
  assert.deepStrictEqual(j.paid.map((r) => [r.tool, r.price_usd]), [['get_spot', 0.001], ['get_perp', 0.005]]);
  const h = await fetch(`${u}/pricing`, { headers: { accept: 'text/html' } });
  assert.match(h.headers.get('content-type'), /html/); assert.match(await h.text(), /<td>get_spot<\/td><td>0.001<\/td>/);
  const tr = await fetch(`${u}/terms`); assert.equal(tr.status, 200); assert.match(await tr.text(), /never settled/);
});
