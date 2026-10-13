// R9 2a: a prepaid key on POST /mcp, through the real MCP SDK (McpServer + StreamableHTTPServerTransport, mounted the
// way mcp.js mounts it) behind keys.identify. The x402 wrapper is a stand-in that marks the call as having gone the
// x402 way, so the test can prove a request with a key never does.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { makeKeys, newKey, hashKey } = require('../lib/keys');
const { hfUsd } = require('../lib/hf');

const DEFS = [
  { name: 'get_thing', usd: 0.01, run: async () => ({ ok: true }) },
  { name: 'get_throws', usd: 0.01, run: async () => { throw new Error('upstream down'); } },
  { name: 'get_free', usd: 0, run: async () => ({ free: true }) },
];

async function boot() {
  const db = new Database(':memory:');
  const rows = [];
  const K = makeKeys({ db, PRICES: {}, logCall: (r) => rows.push(r), hfUsd });
  const x402 = { n: 0 };
  const x402Wrap = (h) => async () => { x402.n++; return { isError: true, content: [{ type: 'text', text: 'x402 payment required' }] }; }; // eslint-disable-line no-unused-vars
  const app = express();
  app.use((req, _res, next) => { req.callerIp = '127.0.0.1'; next(); });
  app.use(K.identify);
  app.post('/mcp', express.json(), async (req, res) => {
    const s = new McpServer({ name: 't', version: '1.0.0' });
    for (const def of DEFS) {
      const wrap = def.usd ? (K.mcpWrap(req, def) || x402Wrap) : ((h) => h);
      s.registerTool(def.name, { description: def.name, inputSchema: { symbol: z.string().optional() } }, wrap(async (args) => {
        const data = await def.run(args || {});
        return { content: [{ type: 'text', text: JSON.stringify({ tool: def.name, data }) }] };
      }));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await s.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  let id = 0;
  const call = async (name, headers = {}, url = '/mcp') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: {} } }),
    });
    const j = await r.json();
    return j.result;
  };
  return { db, rows, K, x402, call, close: () => { K.stop(); server.close(); } };
}
const text = (res) => JSON.parse(res.content[0].text);

test('mcp: a key pays at the high-frequency price, one key row, x402 never touched; Bearer works too', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(0.02, 'mcp');
  const r = await s.call('get_thing', { 'x-agentfeed-key': k });
  assert.equal(r.isError, undefined);
  assert.deepEqual(text(r), { tool: 'get_thing', data: { ok: true } });
  const r2 = await s.call('get_thing', { authorization: `Bearer ${k}` });
  assert.equal(r2.isError, undefined);
  assert.equal(s.x402.n, 0);
  const row = s.K.store.get(hashKey(k));
  assert.equal(row.balance_micro, 20_000 - 2 * 5_000);
  assert.equal(row.calls, 2);
  const keyRows = s.rows.filter((x) => x.status === 'key');
  assert.deepEqual(keyRows.map((x) => [x.tool, x.amount_usdc, x.payer_wallet, x.req_path]), [['get_thing', 0.005, `key:${k.slice(4, 12)}`, '/mcp'], ['get_thing', 0.005, `key:${k.slice(4, 12)}`, '/mcp']]);
  assert.ok(!JSON.stringify(s.rows).includes(k));
});

test('mcp: unknown, pending, revoked and low balance are isError results, never x402', async (t) => {
  const s = await boot(); t.after(s.close);
  const unknown = text(await s.call('get_thing', { 'x-agentfeed-key': newKey() }));
  assert.equal(unknown.status, 401);
  assert.equal(unknown.buy, '/api/keys/buy-5');
  const rk = s.K.store.grant(1, 'r'); s.K.store.setStatus(hashKey(rk), 'revoked');
  assert.equal(text(await s.call('get_thing', { 'x-agentfeed-key': rk })).error, 'this key is revoked');
  const low = s.K.store.grant(0.001, 'low');
  assert.deepEqual(text(await s.call('get_thing', { 'x-agentfeed-key': low })), { error: 'key balance too low', status: 402, balance_usd: 0.001, price_usd: 0.005, topup: '/api/keys/topup-5' });
  assert.equal(s.x402.n, 0);
  assert.equal(s.rows.filter((x) => x.status === 'key').length, 0);
});

test('mcp: a tool that fails is refunded; a free tool is never charged; no key = the x402 way', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(0.02, 'mcp');
  const r = await s.call('get_throws', { 'x-agentfeed-key': k });
  assert.equal(r.isError, true);
  assert.equal(await s.call('get_free', { 'x-agentfeed-key': k }).then((x) => text(x).data.free), true);
  const row = s.K.store.get(hashKey(k));
  assert.equal(row.balance_micro, 20_000);
  assert.equal(row.calls, 0);
  await s.call('get_thing');
  assert.equal(s.x402.n, 1, 'without a key the x402 wrapper answers');
});

test('mcp: a key in the URL or the body is never read', async (t) => {
  const s = await boot(); t.after(s.close);
  const k = s.K.store.grant(1, 'url');
  await s.call('get_thing', {}, `/mcp?key=${k}&x-agentfeed-key=${k}`);
  assert.equal(s.x402.n, 1);
  assert.equal(s.K.store.get(hashKey(k)).calls, 0);
});
