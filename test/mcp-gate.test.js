// lib/mcp-gate.js (R15d): runTool runs an MCP tool and turns a GATED tool's 429 into the REST body as an isError result. Every other outcome is
// exactly what mcp.js did before: data on success, a thrown error rethrown, the pass-key context handed only to a tool flagged mcpGate.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTool } = require('../lib/mcp-gate');
const { rateLimitBody } = require('../lib/tool');

const err = (status, extra = {}, msg = 'boom') => Object.assign(new Error(msg), { status, ...extra });

test('success: { data }, with the context passed to a mcpGate tool only', async () => {
  const seen = [];
  const run = (a, ctx) => { seen.push([a, ctx]); return { ok: true }; };
  const ctx = { caller: { key: 'key:abc', pass: true } };
  assert.deepEqual(await runTool({ name: 't', mcpGate: true, run }, { x: 1 }, ctx), { data: { ok: true } });
  assert.deepEqual(await runTool({ name: 't', run }, { x: 2 }, ctx), { data: { ok: true } });
  assert.deepEqual(await runTool({ name: 't', mcpGate: true, run }, undefined, undefined), { data: { ok: true } });
  assert.deepEqual(seen, [[{ x: 1 }, ctx], [{ x: 2 }, undefined], [{}, undefined]]);
});

test('a gated tool\'s 429 is an isError result with { tool, error, retry_after } and no other field', async () => {
  const def = { name: 'get_liq_feed', mcpGate: true, run: () => { throw err(429, { kind: 'bad_request', retryAfter: 7 }, 'liq-feed: one call every 10 s per key. Retry in 7 s. Not charged.'); } };
  const r = await runTool(def, {}, { caller: { key: 'key:abc', pass: true } });
  assert.equal(r.data, undefined);
  assert.equal(r.refused.isError, true);
  assert.deepEqual(JSON.parse(r.refused.content[0].text), { tool: 'get_liq_feed', error: 'liq-feed: one call every 10 s per key. Retry in 7 s. Not charged.', retry_after: 7 });
  assert.equal(r.refused.structuredContent, undefined);
});

test('retry_after follows the REST clamp: 10 when the error names none, 1 at least, 3600 at most, whole seconds', async () => {
  const body = async (retryAfter) => JSON.parse((await runTool({ name: 't', mcpGate: true, run: () => { throw err(429, { retryAfter }); } }, {})).refused.content[0].text).retry_after;
  assert.equal(await body(undefined), 10);
  assert.equal(await body(0), 10);
  assert.equal(await body(0.2), 10, 'rounds to 0, which names none');
  assert.equal(await body(1.6), 2);
  assert.equal(await body(9999), 3600);
  assert.equal(await body(-5), 1);
  assert.deepEqual(rateLimitBody('t', err(429, { retryAfter: 7 }, 'm')), { ra: 7, body: { tool: 't', error: 'm', retry_after: 7 } }, 'the helper REST and MCP share');
});

test('everything else is unchanged: another status from a gated tool and any error from an ungated tool are rethrown', async () => {
  await assert.rejects(runTool({ name: 'g', mcpGate: true, run: () => { throw err(400, { kind: 'bad_request' }, 'symbols is empty'); } }, {}), /symbols is empty/);
  await assert.rejects(runTool({ name: 'g', mcpGate: true, run: () => { throw err(503, { retryAfter: 30 }, 'tape stale'); } }, {}), /tape stale/);
  await assert.rejects(runTool({ name: 'g', mcpGate: true, run: () => { throw new Error('upstream down'); } }, {}), /upstream down/);
  await assert.rejects(runTool({ name: 'u', run: () => { throw err(429, { retryAfter: 5 }, 'not ours to convert'); } }, {}), /not ours to convert/, 'an ungated tool\'s 429 is not touched');
});

test('an async run that rejects with a 429 is converted too', async () => {
  const r = await runTool({ name: 'a', mcpGate: true, run: async () => { throw err(429, { retryAfter: 5 }, 'x'); } }, {});
  assert.equal(r.refused.isError, true);
  assert.equal(JSON.parse(r.refused.content[0].text).retry_after, 5);
});

// ---- who the caller is (R15e): a key by its prefix, an x402 payer by the wallet the facilitator verified, nobody otherwise
const { callerCtx, trackPayers } = require('../lib/mcp-gate');

test('callerCtx: a key caller wins; a verified payer is wallet:<payer> (EVM lower-cased, Solana as is); no identity is ungated', () => {
  const key = { key: 'key:abcd1234', pass: true };
  assert.deepEqual(callerCtx(key, () => '0xABC', {}), { caller: key }, 'a request with a key is that key, whatever else is asked');
  assert.deepEqual(callerCtx(null, () => '0xAbC123', {}), { caller: { key: 'wallet:0xabc123', pass: false } });
  assert.deepEqual(callerCtx(null, () => '7Yq1AbCdEf', {}), { caller: { key: 'wallet:7Yq1AbCdEf', pass: false } });
  assert.equal(callerCtx(null, () => null, {}), undefined, 'no verified payer: no identity, no gate');
  assert.equal(callerCtx(null, undefined, {}), undefined);
});

test('trackPayers: the payer a facilitator verified is found again from the tool context, per payment, and never for an invalid or unnamed payment', async () => {
  const answers = new Map();
  const rs = { async verifyPayment(payload) { return answers.get(payload); } };
  const payerFor = trackPayers(rs);
  const p1 = { x: 1 }, p2 = { x: 2 }, p3 = { x: 3 }, p4 = { x: 4 };
  answers.set(p1, { isValid: true, payer: '0xAAA' });
  answers.set(p2, { isValid: true, payer: '0xBBB' });
  answers.set(p3, { isValid: false, payer: '0xCCC', invalidReason: 'bad' });
  answers.set(p4, { isValid: true });
  for (const p of [p1, p2, p3, p4]) await rs.verifyPayment(p);
  const ctx = (p) => ({ meta: { 'x402/payment': p } });
  assert.equal(payerFor(ctx(p1)), '0xAAA');
  assert.equal(payerFor(ctx(p2)), '0xBBB', 'two payments in one request keep their own payers');
  assert.equal(payerFor(ctx(p3)), null, 'an invalid payment names nobody');
  assert.equal(payerFor(ctx(p4)), null, 'a verify answer with no payer names nobody');
  assert.equal(payerFor(ctx({ x: 1 })), null, 'a look-alike object is not the verified one');
  assert.equal(payerFor({}), null);
  assert.equal(payerFor(undefined), null);
});
