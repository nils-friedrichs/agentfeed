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
  try { first = def.run({ symbols: 'BTC' }, { passGateKey: 'key:r15dtest' }); } catch (e) { if (e.status === 503) return; throw e; }   // a stale tape cannot show the gate
  assert.ok(first && Array.isArray(first.buckets), 'the first call is served');
  assert.throws(() => def.run({ symbols: 'BTC' }, { passGateKey: 'key:r15dtest' }), (e) => e.status === 429 && /one call every 10 s per key/.test(e.message) && e.retryAfter >= 1, 'the second call, same key, is refused');
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }, { passGateKey: 'key:r15dother' }), 'another key has its own clock');
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }), 'no pass key: not gated over MCP, as before');
  assert.doesNotThrow(() => def.run({ symbols: 'BTC' }), 'and not on the next call either');
  LF._callers.clear();
});
