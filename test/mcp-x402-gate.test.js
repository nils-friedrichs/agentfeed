// R15e: the get_liq_feed clock for an x402 MCP caller, through the REAL @x402/mcp payment wrapper (as test/mcp-ctx.test.js does) with a stub
// facilitator. The wrapper verifies the payment, then runs the tool, then settles only if the tool did not answer isError. So the wallet is known
// by the time the tool runs (lib/mcp-gate.js trackPayers), and a refusal returned as an isError result is never settled, i.e. never billed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createPaymentWrapper, x402ResourceServer } = require('@x402/mcp');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { runTool, trackPayers, callerCtx } = require('../lib/mcp-gate');

const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const WALLET_A = '0x' + 'aB'.repeat(20);
const WALLET_B = '0x' + 'cD'.repeat(20);

async function boot({ payerOnVerify = true } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const calls = [];
  const fac = { settles: 0, verifies: 0,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify(payload) { this.verifies++; const from = payload.payload.authorization.from; return { isValid: true, ...(payerOnVerify ? { payer: from } : {}) }; },
    async settle(payload) { this.settles++; return { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: payload.payload.authorization.from }; } };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  await rs.initialize();
  const payerFor = trackPayers(rs);
  const accepts = await rs.buildPaymentRequirements({ scheme: 'exact', network: NET, payTo: PAYTO, price: '$0.001' });
  const wrap = createPaymentWrapper(rs, { accepts, resource: { url: 'mcp://tool/get_liq_feed', description: 'get_liq_feed', mimeType: 'application/json' } });
  // the tool: the same shape as the real one, a 5 s caller clock (tools/liqfeed.js is exercised in test/liqfeed.test.js; this is the gate's plumbing)
  const LF = require('../tools/liqfeed');
  const def = { name: 'get_liq_feed', mcpGate: true, run: (a, ctx) => { calls.push(ctx && ctx.caller && ctx.caller.key); return LF.getLiqFeed(a, ctx, { now: () => clock.t, db: tape, baseline: () => new Map(), tapeSymbol: (s) => s }); } };
  const app = express();
  app.post('/mcp', express.json(), async (req, res) => {
    const s = new McpServer({ name: 't', version: '1.0.0' });
    s.registerTool('get_liq_feed', { description: 'get_liq_feed', inputSchema: { symbols: z.string().optional() } }, wrap(async (args, context) => {
      const ran = await runTool(def, args, callerCtx(null, payerFor, context));
      if (ran.refused) return ran.refused;
      return { content: [{ type: 'text', text: JSON.stringify({ tool: 'get_liq_feed', data: { count: (ran.data.buckets || []).length } }) }] };
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await s.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  let id = 0;
  const paid = async (wallet) => {
    const payment = { x402Version: 2, accepted: accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: wallet, to: PAYTO, value: accepts[0].amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + '07'.repeat(32) } } };
    const r = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'get_liq_feed', arguments: { symbols: 'BTC' }, _meta: { 'x402/payment': payment } } }) });
    return (await r.json()).result;
  };
  return { fac, calls, clock, paid, close: () => server.close() };
}

// a tiny tape for the tool: BTC prints every 2.5 s around the clock below
const Database = require('better-sqlite3');
const tape = new Database(':memory:');
tape.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit');`);
{ const ins = tape.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd) VALUES (?, ?, ?, ?, ?, ?)'); const T = 1_800_000_000_000; for (let ts = T - 600_000; ts < T + 600_000; ts += 2_500) ins.run(ts, 'BTCUSDT', 'Buy', 1, 80_000, 80_000); }

test('x402 over MCP: the wallet is the caller; a call inside 5 s is refused as isError with the REST body and is NOT settled; another wallet and the next bucket are served', async (t) => {
  require('../tools/liqfeed')._callers.clear();
  const s = await boot(); t.after(s.close);
  const r1 = await s.paid(WALLET_A);
  assert.equal(r1.isError, undefined, JSON.stringify(r1).slice(0, 300));
  assert.equal(s.fac.settles, 1, 'the first call is billed');
  s.clock.t += 3_000;
  const r2 = await s.paid(WALLET_A);
  assert.equal(r2.isError, true);
  const body = JSON.parse(r2.content[0].text);
  assert.deepEqual(Object.keys(body), ['tool', 'error', 'retry_after']);
  assert.equal(body.retry_after, 2);
  assert.match(body.error, /one call every 5 s per payer/);
  assert.equal(s.fac.settles, 1, 'the refusal was not settled: unbilled');
  const rb = await s.paid(WALLET_B);
  assert.equal(rb.isError, undefined, 'another wallet has its own clock');
  assert.equal(s.fac.settles, 2);
  s.clock.t += 2_000;                                                      // 5.0 s after wallet A's first call
  const r3 = await s.paid(WALLET_A);
  assert.equal(r3.isError, undefined, 'served at 5.0 s');
  assert.equal(s.fac.settles, 3);
  assert.deepEqual([...new Set(s.calls)].sort(), [`wallet:${WALLET_A.toLowerCase()}`, `wallet:${WALLET_B.toLowerCase()}`].sort(), 'EVM wallets are keyed lower-case');
});

test('x402 over MCP: a facilitator whose verify names no payer leaves the caller ungated (and the call is billed as before)', async (t) => {
  require('../tools/liqfeed')._callers.clear();
  const s = await boot({ payerOnVerify: false }); t.after(s.close);
  for (let i = 0; i < 3; i++) assert.equal((await s.paid(WALLET_A)).isError, undefined);
  assert.equal(s.fac.settles, 3);
  assert.deepEqual(s.calls, [undefined, undefined, undefined], 'no identity reached the tool');
});
