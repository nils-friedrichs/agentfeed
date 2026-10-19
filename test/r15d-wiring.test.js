// R15d (19 Oct 2026): over MCP a pass key is gated on the REST liq-feed clock. The pieces are unit-tested elsewhere (liqfeed.test.js: one clock
// across REST and MCP; keys-daypass.test.js: passGateKey). This file pins the WIRING in the real tool table, which needs the box databases
// (expansion.js opens them on require), so, like r15-wiring.test.js, it skips with a reason on a machine without them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
const skip = HAVE_BOX ? false : 'needs the box databases (/opt/agentfeed/liquidations.db, /opt/overhang/overhang.db)';

test('mcp tool table: only get_liq_feed carries mcpGate, and its run forwards the pass-key context to the liq-feed gate', { skip }, () => {
  const { TOOL_DEFS } = require('../mcp');
  const gated = TOOL_DEFS.filter((d) => d.mcpGate).map((d) => d.name);
  assert.deepEqual(gated, ['get_liq_feed']);
  const LF = require('../tools/liqfeed');
  const def = TOOL_DEFS.find((d) => d.name === 'get_liq_feed');
  LF._callers.clear();
  let first;
  const pass = { caller: { key: 'key:r15dtest', pass: true } };
  try { first = def.run({ symbols: 'BTC' }, pass); } catch (e) { if (e.status === 503) return; throw e; }   // a stale tape cannot show the gate
  assert.ok(first && Array.isArray(first.buckets), 'the first call is served');
  assert.throws(() => def.run({ symbols: 'BTC' }, pass), (e) => e.status === 429 && /one call every 10 s per key/.test(e.message) && e.retryAfter >= 1, 'the second call, same pass key, is refused');
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }, { caller: { key: 'key:r15dother', pass: true } }), 'another key has its own clock');
  const pack = { caller: { key: 'key:r15dpack', pass: false } };
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }, pack));
  assert.throws(() => def.run({ symbols: 'BTC' }, pack), (e) => e.status === 429 && /one call every 5 s per key/.test(e.message), 'a pack key is on the 5 s clock');
  const wallet = { caller: { key: 'wallet:r15dwallet', pass: false } };
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }, wallet));
  assert.throws(() => def.run({ symbols: 'BTC' }, wallet), (e) => e.status === 429 && /one call every 5 s per payer/.test(e.message), 'an x402 wallet is on the 5 s clock');
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }), 'no identity: not gated over MCP');
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }), 'and not on the next call either');
  LF._callers.clear();
});
