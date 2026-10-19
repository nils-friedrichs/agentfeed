// lib/agent-ready.js — what Cloudflare's Agent Readiness scan and the agent registries read (R17, 19 Oct 2026).
//
// The scan of https://x402.ochinimus.app on 19 Oct ~08:40Z scored 27, level 1. Each document below answers one failing check, and every one of
// them is derived from what the service mounts, never restated:
//
//   /.well-known/ai-catalog.json and /.well-known/ard.json   the ARD manifest (ards-project/ard-spec v0.91): specVersion, a host object and
//        an entries array; each entry a urn:air:<host>:<namespace>:<name> identifier, displayName, an IANA media type in `type`, exactly one
//        of url/data, and 2-5 representativeQueries. ard.json is the path ARD v0.91 resolves first; ai-catalog.json is its predecessor path,
//        served so a consumer that reads only that one finds the same document. The document validates against both vendored schemas
//        (test/fixtures/ard/). robots.txt names it with the Agentmap directive the spec defines (lib/compat.js).
//   /.well-known/api-catalog                                  RFC 9727, application/linkset+json, anchor <origin>/api
//   Link headers on GET / and GET /api                        RFC 8288: api-catalog, service-desc, service-doc (registered relations only)
//   GET / with Accept: text/markdown                          the llms.txt text, Vary: Accept
//   /.well-known/agent-skills/index.json                      Agent Skills Discovery RFC v0.2.0: $schema, skills[] with the sha256 digest of the
//        bytes /SKILL.md serves (recomputed whenever the served text changes, i.e. at boot)
//   /auth.md                                                  no registration: x402, MPP, or a prepaid key or pass
//
// Every document is `Cache-Control: no-cache` with the ETag Express adds (a conditional GET is a 304), and the JSON ones carry
// Access-Control-Allow-Origin: * (they are public discovery documents).
'use strict';
const crypto = require('crypto');

const MCP_CARD_TYPE = 'application/mcp-server-card+json';
const A2A_CARD_TYPE = 'application/a2a-agent-card+json';
const OPENAPI_TYPE = 'application/vnd.oai.openapi+json';   // IANA-registered (OpenAPI Initiative)
const LINKSET_TYPE = 'application/linkset+json';
const RFC9727_PROFILE = 'https://www.rfc-editor.org/info/rfc9727';
const SKILLS_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

/** The ARD manifest. Validates against ai-catalog.schema.json (strict top level: specVersion, host, entries) and the ArdManifest definition. */
function buildArdCatalog({ ORIGIN }) {
  const host = new URL(ORIGIN).host;
  const urn = (ns, name) => `urn:air:${host}:${ns}:${name}`;
  return {
    specVersion: '1.0',
    host: { displayName: 'AgentFeed', documentationUrl: `${ORIGIN}/llms.txt`, logoUrl: `${ORIGIN}/icon.png` },
    entries: [
      {
        identifier: urn('mcp', 'agentfeed'),
        displayName: 'AgentFeed MCP server',
        type: MCP_CARD_TYPE,
        url: `${ORIGIN}/mcp/server-card`,
        description: 'MCP server (streamable HTTP) for crypto market data, Solana pre-trade checks, sanctions screening, papers and utilities. Paid tools answer with an x402 payment request.',
        representativeQueries: [
          'Which liquidations just printed on SOL perps?',
          'What is the funding rate on BTC perps right now?',
          'Is this Solana token a honeypot before I buy it?',
          'Is this wallet address on a sanctions list?',
        ],
      },
      {
        identifier: urn('openapi', 'agentfeed'),
        displayName: 'AgentFeed OpenAPI document',
        type: OPENAPI_TYPE,
        url: `${ORIGIN}/openapi.json`,
        description: 'OpenAPI 3.1 for every AgentFeed route: parameters, prices in USDC, x402 payment info and a real response example for each.',
        representativeQueries: [
          'Which API sells liquidation pressure per symbol in 5-second buckets?',
          'What does one call to each crypto market data endpoint cost?',
          'How do I call a paid x402 endpoint and what do I get back?',
        ],
      },
      {
        identifier: urn('a2a', 'agentfeed'),
        displayName: 'AgentFeed A2A agent card',
        type: A2A_CARD_TYPE,
        url: `${ORIGIN}/.well-known/agent-card.json`,
        description: 'A2A agent card listing every AgentFeed skill with its price. Each skill is a paid HTTP GET, not an A2A message endpoint.',
        representativeQueries: [
          'Which skills does the AgentFeed agent offer and at what price?',
          'Find an agent that sells perp funding and open interest data per call',
        ],
      },
      {
        identifier: urn('docs', 'llms-txt'),
        displayName: 'AgentFeed llms.txt',
        type: 'text/plain',
        url: `${ORIGIN}/llms.txt`,
        description: 'Plain-text overview of AgentFeed for language models: how to pay, the rails, every route with its price, and the machine-readable documents.',
        representativeQueries: [
          'How do I pay for AgentFeed calls with x402 USDC?',
          'Give me a plain-text overview of the AgentFeed routes and prices',
        ],
      },
    ],
  };
}

/** RFC 9727 API catalog: a linkset (RFC 9264) whose anchor is the API entry point. */
function buildApiCatalog({ ORIGIN }) {
  return {
    linkset: [{
      anchor: `${ORIGIN}/api`,
      'service-desc': [{ href: `${ORIGIN}/openapi.json`, type: OPENAPI_TYPE }],
      'service-doc': [{ href: `${ORIGIN}/llms.txt`, type: 'text/plain' }],
      status: [{ href: `${ORIGIN}/health`, type: 'application/json' }],
    }],
  };
}

/** The Link header (RFC 8288) for GET / and GET /api. */
function linkHeader(ORIGIN) {
  return [
    `<${ORIGIN}/.well-known/api-catalog>; rel="api-catalog"`,
    `<${ORIGIN}/openapi.json>; rel="service-desc"; type="${OPENAPI_TYPE}"`,
    `<${ORIGIN}/llms.txt>; rel="service-doc"; type="text/plain"`,
  ].join(', ');
}

/** Agent Skills Discovery RFC v0.2.0 index: one skill, SKILL.md, digest = sha256 of the exact bytes served at /SKILL.md. */
function buildSkillsIndex({ ORIGIN, skillText }) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(skillText);
  const field = (k) => { const m = fm && new RegExp(`^${k}: (.*)$`, 'm').exec(fm[1]); return m ? m[1].trim() : null; };
  const name = field('name') || 'agentfeed';
  const description = (field('description') || 'Paid crypto market data and checks for AI agents, per call in USDC over x402.').slice(0, 1024);
  const digest = `sha256:${crypto.createHash('sha256').update(Buffer.from(skillText, 'utf8')).digest('hex')}`;
  return { $schema: SKILLS_SCHEMA, skills: [{ name, type: 'skill-md', description, url: `${ORIGIN}/SKILL.md`, digest }] };
}

/** /auth.md: short, from the price table (the key routes and their prices are read, not typed). */
function buildAuthMd({ ORIGIN, PRICES }) {
  const keyRoutes = Object.entries(PRICES || {}).filter(([r]) => /^GET \/api\/keys\/buy-/.test(r)).map(([r, p]) => `- \`${r.replace('GET ', '')}\`: $${p.usd}`);
  return [
    '# Authentication',
    '',
    'AgentFeed needs no registration, no account and no API key. Every paid route is a GET that answers 402 with a payment request; pay it and repeat the request.',
    '',
    '## Pay per call',
    '',
    `- **x402 (v2):** read the base64 challenge in the \`PAYMENT-REQUIRED\` response header, pay in USDC, repeat the request with a \`PAYMENT-SIGNATURE\` header. Rails are listed in [llms.txt](${ORIGIN}/llms.txt).`,
    '- **MPP:** the same 402 also carries `WWW-Authenticate` payment challenges (tempo/charge on every paid route, solana/charge on two).',
    '',
    '## Prepaid key or pass',
    '',
    `For a client that cannot sign an x402 payment: buy a key once, then send it as \`X-AgentFeed-Key: afk_...\` (or \`Authorization: Bearer afk_...\`). A key call draws half the route price from the balance (\`GET ${ORIGIN}/api/keys/balance\`, free); a pass is flat-fee for the routes it lists. Page: ${ORIGIN}/keys.`,
    '',
    ...keyRoutes,
    '',
    '## More',
    '',
    `- [llms.txt](${ORIGIN}/llms.txt): how to pay, every route and its price`,
    `- [openapi.json](${ORIGIN}/openapi.json): parameters, prices and examples`,
    '',
  ].join('\n');
}

// ---- Accept negotiation for GET /: markdown only when it is the client's clear first choice, so browsers (text/html first) and JSON clients are untouched
function parseAccept(header) {
  return String(header || '').split(',').map((s) => s.trim()).filter(Boolean).map((r, i) => {
    const [type, ...params] = r.split(';').map((x) => x.trim());
    let q = 1;
    for (const p of params) { const m = /^q=([0-9.]+)$/i.exec(p); if (m) q = Number(m[1]); }
    return { type: type.toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
  });
}
/** true when text/markdown is named and beats every other named choice among text/html and application/json (ties: the one listed first). */
function prefersMarkdown(header) {
  const named = parseAccept(header).filter((x) => x.q > 0 && ['text/markdown', 'text/html', 'application/json'].includes(x.type));
  if (!named.some((x) => x.type === 'text/markdown')) return false;
  named.sort((a, b) => b.q - a.q || a.i - b.i);
  return named[0].type === 'text/markdown';
}

/** GET /: Link header and Vary on every representation; the markdown one when asked for (the llms.txt text). */
function rootNegotiation({ ORIGIN, llmsText }) {
  const link = linkHeader(ORIGIN);
  return function root(req, res, next) {
    res.set('Link', link).vary('Accept');
    if (prefersMarkdown(req.headers.accept)) {
      return res.set('Cache-Control', 'no-cache').type('text/markdown; charset=utf-8').send(llmsText());
    }
    return next();
  };
}

/** Mounts the documents with no other home: ard.json, api-catalog, the skills index and /auth.md. (ai-catalog.json: lib/compat.js makeAiCatalog.) */
function mountAgentReady(app, { docs, PRICES, ORIGIN }) {
  const send = (res, type, body, json = true) => {
    res.set('Cache-Control', 'no-cache');
    if (json) res.set('Access-Control-Allow-Origin', '*');
    return res.type(type).send(body);
  };
  app.get('/.well-known/ard.json', (_req, res) => send(res, 'application/json; charset=utf-8', JSON.stringify(buildArdCatalog({ ORIGIN }))));
  // a Buffer, not a string: res.send(string) would put `charset=utf-8` before the profile parameter, and application/linkset+json defines none
  app.get('/.well-known/api-catalog', (_req, res) => send(res, `${LINKSET_TYPE}; profile="${RFC9727_PROFILE}"`, Buffer.from(JSON.stringify(buildApiCatalog({ ORIGIN })), 'utf8')));
  // the digest follows the served text: recomputed only when docs().skill is a different string (once, at boot)
  let lastText = null, lastBody = null;
  app.get('/.well-known/agent-skills/index.json', (_req, res) => {
    const text = docs().skill;
    if (text !== lastText) { lastBody = JSON.stringify(buildSkillsIndex({ ORIGIN, skillText: text })); lastText = text; }
    return send(res, 'application/json; charset=utf-8', lastBody);
  });
  app.get('/auth.md', (_req, res) => send(res, 'text/markdown; charset=utf-8', buildAuthMd({ ORIGIN, PRICES }), false));
}

module.exports = {
  buildArdCatalog, buildApiCatalog, buildSkillsIndex, buildAuthMd, linkHeader, parseAccept, prefersMarkdown, rootNegotiation, mountAgentReady,
  MCP_CARD_TYPE, A2A_CARD_TYPE, OPENAPI_TYPE, LINKSET_TYPE, RFC9727_PROFILE, SKILLS_SCHEMA,
};
