// R15b: the `related` array on the free routes (fear-greed, last-liquidation, exit-method): at most two items naming the closest paid
// route, as plain data { tool, path, price_usd, adds }, the price read from the price table, no imperative wording.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { relatedFor, SPEC } = require('../lib/related');
const { commands, KNOWN_BAD } = require('./helpers/instructs');

const PRICES = {
  'GET /api/market-snapshot': { usd: 0.005, tool: 'get_market_snapshot' }, 'GET /api/market-state': { usd: 0.02, tool: 'get_market_state' },
  'GET /api/liquidations': { usd: 0.005, tool: 'get_recent_liquidations' }, 'GET /api/liq-feed': { usd: 0.001, tool: 'get_liq_feed' }, 'GET /api/exit-quote': { usd: 0.02, tool: 'get_exit_quote' },
};

test('shape: tool, path, price_usd, adds, at most two items, prices from the table', () => {
  for (const tool of ['get_fear_greed', 'get_last_liquidation', 'get_exit_method']) {
    const r = relatedFor(tool, PRICES);
    assert.ok(r.length >= 1 && r.length <= 2, tool);
    for (const x of r) {
      assert.deepEqual(Object.keys(x), ['tool', 'path', 'price_usd', 'adds']);
      const entry = PRICES[`GET ${x.path}`];
      assert.deepEqual([x.tool, x.price_usd], [entry.tool, entry.usd]);
      assert.ok(x.adds.length > 30 && x.adds.length < 260);
    }
  }
  assert.deepEqual(relatedFor('get_fear_greed', PRICES).map((x) => x.path), ['/api/market-snapshot', '/api/market-state']);
  assert.deepEqual(relatedFor('get_last_liquidation', PRICES).map((x) => x.path), ['/api/liquidations', '/api/liq-feed']);
  assert.deepEqual(relatedFor('get_exit_method', PRICES).map((x) => x.path), ['/api/exit-quote']);
  assert.deepEqual(relatedFor('get_something_else', PRICES), []);
  assert.deepEqual(Object.keys(SPEC).sort(), ['get_exit_method', 'get_fear_greed', 'get_last_liquidation']);
});

test('a price change shows up; a route that left the table is dropped, not published stale', () => {
  assert.equal(relatedFor('get_last_liquidation', { ...PRICES, 'GET /api/liquidations': { usd: 0.01, tool: 'get_recent_liquidations' } })[0].price_usd, 0.01);
  const { 'GET /api/liq-feed': _gone, ...rest } = PRICES;
  assert.deepEqual(relatedFor('get_last_liquidation', rest).map((x) => x.path), ['/api/liquidations']);
});

test('the adds phrases are plain data: no second person, no request, no leading imperative (detector first checked on known-bad strings)', () => {
  for (const bad of KNOWN_BAD) assert.ok(commands(bad).length > 0, bad);
  for (const [tool, items] of Object.entries(SPEC)) for (const x of items) assert.deepEqual(commands(x.adds), [], `${tool} ${x.route}`);
});

test('the three free routes and the three MCP tools attach it, and no paid tool does', () => {
  const server = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const mcp = fs.readFileSync(require('path').join(__dirname, '..', 'mcp.js'), 'utf8');
  for (const t of ['get_fear_greed', 'get_last_liquidation', 'get_exit_method']) {
    assert.ok(server.includes(`related: relatedFor('${t}', PRICES)`), `server.js ${t}`);
    assert.ok(mcp.includes(`relatedFor('${t}', require('./payments').PRICES)`), `mcp.js ${t}`);
  }
  assert.equal((server.match(/related: relatedFor\(/g) || []).length, 3);
  assert.equal((mcp.match(/relatedFor\(/g) || []).length, 3);
});
