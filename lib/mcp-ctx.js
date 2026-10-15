// lib/mcp-ctx.js — the HTTP request behind an MCP tool call, for the rows a hook writes without seeing it.
//
// The x402 MCP wrapper's onAfterSettlement hook (mcp.js) is built once at start-up and is handed the settlement, never the
// request. The key rail's wrapper is built per request (lib/keys.js mcpWrap) and already logs req_path, method and user_agent.
// POST /mcp runs the transport inside runInMcpRequest, and the hook reads mcpRequestRow(): the same three fields, from the
// same request, through AsyncLocalStorage (it follows the promise chain the MCP SDK uses to reach the tool callback).
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

/** Runs fn (returns its result) with this request as the current MCP request. */
function runInMcpRequest(req, fn) {
  return store.run({ userAgent: req && req.headers ? req.headers['user-agent'] : undefined }, fn);
}

/** The calls-row fields of the current MCP request; {} outside one. */
function mcpRequestRow() {
  const c = store.getStore();
  return c ? { req_path: '/mcp', user_agent: c.userAgent, method: 'POST' } : {};
}

module.exports = { runInMcpRequest, mcpRequestRow };
