// tools/scope.js — the one sentence that says what AgentFeed sells, for every service-level description.
//
// Until R11 every service text said "crypto market data" only; since R11 a third of the catalogue is Solana pre-trade checks,
// sanctions screening, papers, utilities and fixed-purpose language tasks. The JSON at GET /, /.well-known/x402.json, openapi's
// info, llms.txt, SKILL.md, the MCP server and its instructions, the A2A agent card and the landing page all open with this
// sentence (or its short form), so they cannot drift apart again. Prose only: no counts, no rails, no prices.
'use strict';

const SCOPE = 'Crypto market data for AI agents (liquidations, funding, open interest, prices), Solana pre-trade checks, OFAC sanctions screening, scholarly papers, utilities and fixed-purpose language tasks (OCR, translate, summarize, extract, classify, prompt-injection check, transcribe).';

// for the landing page's meta description and og:description, which must fit 300 characters with the rails and the key sentence
const SCOPE_SHORT = 'Crypto market data, Solana pre-trade checks, sanctions screening, papers, utilities and language tasks (OCR, translate, summarize, extract, classify, transcribe) for AI agents.';

module.exports = { SCOPE, SCOPE_SHORT };
