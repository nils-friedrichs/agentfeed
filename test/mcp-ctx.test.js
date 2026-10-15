// #100 (15 Oct 2026): the x402 MCP wrapper's onAfterSettlement hook is built once and never sees the request, so its 'paid' row had no
// user_agent. lib/mcp-ctx.js carries the request into the hook through AsyncLocalStorage. This runs the REAL @x402/mcp payment wrapper
// with a stub facilitator, behind the real MCP SDK transport, mounted the way mcp.js mounts it (the transport runs inside
// runInMcpRequest), and checks the row the hook writes: req_path '/mcp', the caller's user agent, method POST, one row per call and
// no leak between two concurrent calls with different user agents.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createPaymentWrapper, x402ResourceServer } = require('@x402/mcp');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { runInMcpRequest, mcpRequestRow } = require('../lib/mcp-ctx');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);

async function boot({ useCtx = true } = {}) {
  const rows = [];
  const logCall = (r) => rows.push(r);
  const fac = { settles: 0,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { return { isValid: true, payer: PAYER }; },
    async settle() { this.settles++; return { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: PAYER }; } };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  await rs.initialize();
  const accepts = await rs.buildPaymentRequirements({ scheme: 'exact', network: NET, payTo: PAYTO, price: '$0.01' });
  const wrap = createPaymentWrapper(rs, {
    accepts,
    resource: { url: 'mcp://tool/get_thing', description: 'get_thing', mimeType: 'application/json' },
    hooks: { onAfterSettlement: async ({ settlement }) => { logCall({ tool: 'get_thing', status: 'paid', tx_sig: settlement && settlement.transaction, ...(useCtx ? mcpRequestRow() : {}) }); } },
  });
  const app = express();
  app.post('/mcp', express.json(), async (req, res) => {
    const s = new McpServer({ name: 't', version: '1.0.0' });
    s.registerTool('get_thing', { description: 'get_thing', inputSchema: { symbol: z.string().optional() } }, wrap(async () => {
      await new Promise((r) => setTimeout(r, 15));                       // the tool body yields, as a real tool does
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await s.connect(transport);
    await runInMcpRequest(req, () => transport.handleRequest(req, res, req.body));
  });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  let id = 0;
  const paid = async (userAgent) => {
    const payment = { x402Version: 2, accepted: accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: accepts[0].amount, validAfter: '0', validBefore: String(2 ** 40), nonce: '0x' + '00'.repeat(32) } } };
    const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(userAgent ? { 'user-agent': userAgent } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'get_thing', arguments: {}, _meta: { 'x402/payment': payment } } }),
    });
    return (await r.json()).result;
  };
  return { rows, fac, paid, close: () => server.close() };
}

test('#100 the x402 MCP paid row records req_path /mcp, the user agent and POST', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.paid('mcp-agent-under-test/3.1');
  assert.equal(r.isError, undefined, JSON.stringify(r).slice(0, 300));
  assert.equal(s.fac.settles, 1);
  assert.equal(s.rows.length, 1);
  assert.deepEqual([s.rows[0].status, s.rows[0].req_path, s.rows[0].user_agent, s.rows[0].method], ['paid', '/mcp', 'mcp-agent-under-test/3.1', 'POST']);
});

test('#100 two concurrent calls with different user agents each get their own', async (t) => {
  const s = await boot(); t.after(s.close);
  const [a, b] = await Promise.all([s.paid('agent-A/1'), s.paid('agent-B/2')]);
  assert.equal(a.isError, undefined); assert.equal(b.isError, undefined);
  assert.deepEqual(s.rows.map((r) => r.user_agent).sort(), ['agent-A/1', 'agent-B/2']);
});

test('#100 control: without the context the hook has no user agent (this is what the paid MCP row looked like before)', async (t) => {
  const s = await boot({ useCtx: false }); t.after(s.close);
  await s.paid('agent-C/3');
  assert.equal(s.rows.length, 1);
  assert.ok(!('user_agent' in s.rows[0]) && !('req_path' in s.rows[0]));
});

test('mcpRequestRow is empty outside a request, and a call with no User-Agent header records undefined, not a stale value', () => {
  assert.deepEqual(mcpRequestRow(), {});
  runInMcpRequest({ headers: {} }, () => assert.deepEqual(mcpRequestRow(), { req_path: '/mcp', user_agent: undefined, method: 'POST' }));
  runInMcpRequest({ headers: { 'user-agent': 'x/1' } }, () => assert.equal(mcpRequestRow().user_agent, 'x/1'));
  assert.deepEqual(mcpRequestRow(), {});
});
