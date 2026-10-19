// lib/mcp-gate.js — run an MCP tool, and turn the rate-limit refusal of a gated tool into the answer REST gives (R15d, 19 Oct 2026).
//
// get_liq_feed throws a 429 (tools/liqfeed.js) when a pass key calls it again inside the 10-second clock. Over REST lib/tool.js turns that into
// a 429 with Retry-After and the body { tool, error, retry_after }. Over MCP the SDK would turn the thrown error into bare text, so here the same
// body comes back as an isError tool result: a client reads `retry_after` (seconds) from the JSON on either surface. Any other error is
// rethrown exactly as before, and a tool that is not flagged `mcpGate` is run exactly as before.
'use strict';
const { rateLimitBody } = require('./tool');

/**
 * The wallet an x402 MCP payment was verified for. The x402 MCP wrapper runs the tool only after the facilitator has verified the payment, but hands
 * the tool neither the verification nor its payer, so verifyPayment is wrapped to remember the payer against the payment payload object, which the
 * wrapper passes to the tool as context.meta['x402/payment'] (the same object). Returns payerFor(context) -> payer string or null. A facilitator
 * whose verify answer names no payer gives null, and that caller is left ungated.
 */
function trackPayers(resourceServer) {
  const payers = new WeakMap();
  const verify = resourceServer.verifyPayment.bind(resourceServer);
  resourceServer.verifyPayment = async (payload, ...rest) => {
    const r = await verify(payload, ...rest);
    if (r && r.isValid && r.payer && payload && typeof payload === 'object') payers.set(payload, String(r.payer));
    return r;
  };
  return (context) => {
    const meta = context && (context.meta || context._meta);
    const payment = meta && meta['x402/payment'];
    return (payment && typeof payment === 'object' && payers.get(payment)) || null;
  };
}

/**
 * The caller context handed to a mcpGate tool: { caller: { key, pass } } or undefined (ungated). A request that carries an active key is that key
 * ('key:<prefix>', the REST rail's string; pass says pass key or pack). Otherwise an x402 payer is 'wallet:<payer>' (EVM addresses lower-cased, as the
 * audit table writes them); with no verified payer there is no identity and the call is not gated.
 */
function callerCtx(keyCaller, payerFor, context) {
  if (keyCaller) return { caller: keyCaller };
  const payer = payerFor ? payerFor(context) : null;
  if (!payer) return undefined;
  return { caller: { key: `wallet:${/^0x/i.test(payer) ? payer.toLowerCase() : payer}`, pass: false } };
}

/** -> { data } on success, { refused } (an MCP tool result with isError true) for a gated tool's 429; anything else throws. */
async function runTool(def, args, gateCtx) {
  try {
    return { data: await def.run(args || {}, def.mcpGate ? gateCtx : undefined) };
  } catch (e) {
    if (def.mcpGate && e && e.status === 429) {
      return { refused: { isError: true, content: [{ type: 'text', text: JSON.stringify(rateLimitBody(def.name, e).body) }] } };
    }
    throw e;
  }
}

module.exports = { runTool, trackPayers, callerCtx };
