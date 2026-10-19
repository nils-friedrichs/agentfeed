// R17 (19 Oct 2026): the agent-readiness documents (lib/agent-ready.js). Real HTTP, the real builders and the real rate limiter classification;
// the documents behind /SKILL.md, /llms.txt and the HTML/JSON roots are stand-ins (server.js builds the real ones). Every new document: status, content
// type, CORS where it is a public JSON document, an ETag and a 304, Cache-Control no-cache. The ARD manifest is validated against the project's own
// vendored schemas (test/fixtures/ard), with the document the scan rejected as the control.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const AR = require('../lib/agent-ready');
const compat = require('../lib/compat');
const DA = require('../lib/discovery-aliases');
const { makeRateLimiter, DOC_PATH } = require('../lib/ratelimit');

const ORIGIN = 'https://x402.ochinimus.app';
const SKILL = '---\nname: agentfeed\ndescription: Crypto market data and checks for AI agents, paid per call in USDC over x402, no API key.\n---\n\n# AgentFeed\nline é — ünïcode, so the digest is over UTF-8 bytes\n';
const LLMS = '# AgentFeed\n\nPlain-text overview.\n';
const PRICES = {
  'GET /api/market-state': { usd: 0.02, tool: 'get_market_state' }, 'GET /api/keys/buy-1': { usd: 1, tool: 'buy_key_1' }, 'GET /api/keys/buy-day-pass': { usd: 1, tool: 'buy_key_day_pass' },
  'GET /api/keys/buy-pass': { usd: 25, tool: 'buy_key_pass' }, 'GET /api/keys/topup-5': { usd: 5, tool: 'topup_key_5' },
};
let skillNow = SKILL;

async function boot() {
  const app = express();
  const rl = makeRateLimiter({ logCall: () => {}, isPricedPath: (p) => !!PRICES[`GET ${p}`], presentsPayment: () => false });
  app.use(rl.middleware);
  const docs = () => ({ skill: skillNow, llms: LLMS, openapi: {}, wellKnown: {} });
  // the same mount order as server.js
  app.get('/openapi.json', (_req, res) => res.json({ openapi: '3.1.0' }));
  app.get('/llms.txt', (_req, res) => res.type('text/plain; charset=utf-8').send(docs().llms));
  app.get('/SKILL.md', (_req, res) => res.type('text/markdown; charset=utf-8').send(docs().skill));
  DA.mountDiscoveryAliases(app, { docs, PRICES, ORIGIN, version: '2.9.0' });
  AR.mountAgentReady(app, { docs, PRICES, ORIGIN });
  app.get('/.well-known/ai-catalog.json', compat.makeAiCatalog({ ORIGIN }));
  app.get('/robots.txt', compat.robotsTxt);
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/', AR.rootNegotiation({ ORIGIN, llmsText: () => docs().llms }));
  app.get('/', (req, res, next) => ((req.headers.accept || '').includes('text/html') ? res.type('html').send('<!doctype html><title>AgentFeed</title>') : next()));
  app.get('/', (_req, res) => res.json({ service: 'agentfeed' }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers: { 'cf-connecting-ip': '203.0.113.7', ...headers } });
  return { get, close: () => srv.close() };
}

// ---- the ARD manifest ------------------------------------------------------------------------------------------------------------------------------
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ard', f), 'utf8'));

test('ARD: the manifest validates against ai-catalog.schema.json and the ArdManifest definition; the document the scan rejected is the control', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
  const catalog = ajv.compile(fx('ai-catalog.schema.json'));
  const entrySchema = fx('ard-entry.schema.json'); ajv.addSchema(entrySchema);
  const manifest = ajv.getSchema(`${entrySchema.$id}#/$defs/ArdManifest`);
  const doc = AR.buildArdCatalog({ ORIGIN });
  assert.ok(catalog(doc), JSON.stringify(catalog.errors));
  assert.ok(manifest(doc), JSON.stringify(manifest.errors));
  const live = { specVersion: '1.0', entries: [{ identifier: 'urn:air:x402.ochinimus.app:mcp:agentfeed', type: 'application/mcp-server-card+json', url: `${ORIGIN}/mcp/server-card` }] };
  assert.equal(catalog(live), false, 'control: the document that was live is rejected');
  assert.match(JSON.stringify(catalog.errors), /displayName/, 'and for the reason the scan gave');
  assert.equal(manifest(live), false);
  const both = JSON.parse(JSON.stringify(doc)); both.entries[0].data = { x: 1 };
  assert.equal(catalog(both), false, 'control: url and data together are rejected');
  const noHost = JSON.parse(JSON.stringify(doc)); noHost.host = {};
  assert.equal(catalog(noHost), false, 'control: a host without displayName is rejected');
});

test('ARD: specVersion, a host object, four entries (MCP card, OpenAPI, A2A card, llms.txt), each with a urn:air identifier, 2-5 queries and one of url/data', () => {
  const doc = AR.buildArdCatalog({ ORIGIN });
  assert.deepEqual(Object.keys(doc), ['specVersion', 'host', 'entries']);
  assert.equal(doc.specVersion, '1.0');
  assert.equal(doc.host.displayName, 'AgentFeed');
  assert.deepEqual(doc.entries.map((e) => e.type), ['application/mcp-server-card+json', 'application/vnd.oai.openapi+json', 'application/a2a-agent-card+json', 'text/plain']);
  assert.deepEqual(doc.entries.map((e) => e.url), [`${ORIGIN}/mcp/server-card`, `${ORIGIN}/openapi.json`, `${ORIGIN}/.well-known/agent-card.json`, `${ORIGIN}/llms.txt`]);
  const seen = new Set();
  for (const e of doc.entries) {
    assert.match(e.identifier, /^urn:air:x402\.ochinimus\.app:[a-z0-9]+:[a-z0-9-]+$/, e.identifier);
    assert.ok(!seen.has(e.identifier), 'identifiers are unique'); seen.add(e.identifier);
    assert.ok(e.displayName && e.description);
    assert.ok(e.representativeQueries.length >= 2 && e.representativeQueries.length <= 5, `${e.identifier}: ${e.representativeQueries.length} queries`);
    assert.ok(('url' in e) !== ('data' in e), 'exactly one of url and data');
    assert.ok(/^[a-z]+\/[a-z0-9.+-]+$/.test(e.type), 'an IANA-shaped media type');
  }
});

test('ai-catalog.json and ard.json: 200, content type, CORS *, ETag, no-cache, a 304; the two paths serve the same document', async (t) => {
  const s = await boot(); t.after(s.close);
  const docs = {};
  for (const [p, type] of [['/.well-known/ai-catalog.json', /^application\/ai-catalog\+json/], ['/.well-known/ard.json', /^application\/json/]]) {
    const r = await s.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', `${p}: CORS`);
    assert.equal(r.headers.get('cache-control'), 'no-cache', p);
    const etag = r.headers.get('etag'); assert.ok(etag, `${p}: ETag`);
    docs[p] = await r.json();
    const again = await s.get(p, { 'if-none-match': etag, 'cache-control': 'max-age=0' });
    assert.equal(again.status, 304, `${p}: a revalidation is a 304`);
  }
  assert.deepEqual(docs['/.well-known/ai-catalog.json'], docs['/.well-known/ard.json']);
  assert.deepEqual(docs['/.well-known/ard.json'], AR.buildArdCatalog({ ORIGIN }));
});

// ---- API catalog (RFC 9727) ------------------------------------------------------------------------------------------------------------------------
test('/.well-known/api-catalog: application/linkset+json with the RFC 9727 profile, anchor /api, service-desc, service-doc and status; ETag, 304, no-cache, CORS', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.get('/.well-known/api-catalog');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/linkset\+json; profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const etag = r.headers.get('etag'); assert.ok(etag);
  const j = await r.json();
  assert.equal(j.linkset.length, 1);
  const l = j.linkset[0];
  assert.equal(l.anchor, `${ORIGIN}/api`);
  assert.deepEqual(l['service-desc'], [{ href: `${ORIGIN}/openapi.json`, type: 'application/vnd.oai.openapi+json' }]);
  assert.deepEqual(l['service-doc'], [{ href: `${ORIGIN}/llms.txt`, type: 'text/plain' }]);
  assert.deepEqual(l.status, [{ href: `${ORIGIN}/health`, type: 'application/json' }]);
  assert.deepEqual(Object.keys(l).sort(), ['anchor', 'service-desc', 'service-doc', 'status']);
  assert.equal((await s.get('/.well-known/api-catalog', { 'if-none-match': etag, 'cache-control': 'max-age=0' })).status, 304);
  assert.equal((await s.get('/health')).status, 200, 'the status link points at a live route');
});

// ---- Link headers (RFC 8288) -----------------------------------------------------------------------------------------------------------------------
const REGISTERED = new Set(['api-catalog', 'service-desc', 'service-doc', 'status', 'describedby', 'alternate', 'canonical', 'self', 'icon', 'next', 'prev']);   // IANA link relation registry (subset: the ones this test could meet)
const parseLinks = (h) => h.split(/,\s*(?=<)/).map((x) => { const m = /^<([^>]+)>(.*)$/.exec(x.trim()); const p = Object.fromEntries([...m[2].matchAll(/;\s*([a-z]+)="([^"]*)"/g)].map((q) => [q[1], q[2]])); return { href: m[1], ...p }; });

test('GET / and GET /api send Link: api-catalog, service-desc, service-doc, registered relations only, each pointing at a live document', async (t) => {
  const s = await boot(); t.after(s.close);
  for (const [p, accept] of [['/', undefined], ['/', 'text/html'], ['/', 'text/markdown'], ['/api', undefined], ['/api/', undefined]]) {
    const r = await s.get(p, accept ? { accept } : {});
    assert.equal(r.status, 200, `${p} ${accept}`);
    const links = parseLinks(r.headers.get('link'));
    assert.deepEqual(links.map((x) => x.rel).sort(), ['api-catalog', 'service-desc', 'service-doc'], `${p} ${accept}`);
    for (const l of links) assert.ok(REGISTERED.has(l.rel), `${l.rel} is a registered relation`);
    const byRel = Object.fromEntries(links.map((x) => [x.rel, x]));
    assert.equal(byRel['api-catalog'].href, `${ORIGIN}/.well-known/api-catalog`);
    assert.equal(byRel['service-desc'].href, `${ORIGIN}/openapi.json`);
    assert.equal(byRel['service-desc'].type, 'application/vnd.oai.openapi+json');
    assert.equal(byRel['service-doc'].href, `${ORIGIN}/llms.txt`);
    for (const l of links) assert.equal((await s.get(new URL(l.href).pathname)).status, 200, `${l.href} resolves`);
  }
  assert.equal((await s.get('/health')).headers.get('link'), null, 'only the two entry points carry the header');
});

// ---- markdown negotiation --------------------------------------------------------------------------------------------------------------------------
test('GET /: Accept text/markdown returns the llms.txt text as text/markdown; charset=utf-8 with Vary: Accept; browsers, JSON clients and */* are unchanged', async (t) => {
  const s = await boot(); t.after(s.close);
  const md = await s.get('/', { accept: 'text/markdown' });
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.match(md.headers.get('vary'), /\bAccept\b/);
  assert.equal(md.headers.get('cache-control'), 'no-cache');
  assert.equal(await md.text(), LLMS);
  const etag = md.headers.get('etag'); assert.ok(etag);
  assert.equal((await s.get('/', { accept: 'text/markdown', 'if-none-match': etag, 'cache-control': 'max-age=0' })).status, 304);
  // the rest, as before: HTML for a browser, JSON for everything else
  const html = await s.get('/', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' });
  assert.match(html.headers.get('content-type'), /^text\/html/); assert.match(await html.text(), /<!doctype html>/);
  assert.match(html.headers.get('vary'), /\bAccept\b/, 'the HTML answer varies on Accept too, so a cache keeps the three apart');
  for (const accept of [undefined, '*/*', 'application/json', 'application/json, text/markdown;q=0.5', 'text/markdown;q=0']) {
    const r = await s.get('/', accept ? { accept } : {});
    assert.match(r.headers.get('content-type'), /^application\/json/, `Accept ${accept}`);
    assert.deepEqual(await r.json(), { service: 'agentfeed' }, `Accept ${accept}`);
    assert.match(r.headers.get('vary'), /\bAccept\b/);
  }
});

test('prefersMarkdown: markdown only when text/markdown is named and is the first choice among markdown, html and json', () => {
  const P = AR.prefersMarkdown;
  for (const a of ['text/markdown', 'text/markdown, text/html;q=0.9', 'text/markdown;q=1, application/json;q=0.5', 'text/markdown, application/json', 'TEXT/MARKDOWN', 'text/markdown, */*;q=0.1']) assert.equal(P(a), true, a);
  for (const a of [undefined, '', '*/*', 'text/html', 'text/html,application/xhtml+xml,*/*;q=0.8', 'application/json', 'application/json, text/markdown;q=0.5', 'text/html, text/markdown', 'text/markdown;q=0', 'text/*', 'text/plain', 'text/markdown;q=0.4, text/html']) assert.equal(P(a), false, String(a));
});

// ---- Agent Skills index ----------------------------------------------------------------------------------------------------------------------------
test('/.well-known/agent-skills/index.json: $schema, skills[] with name, type, description, url and the sha256 of the bytes /SKILL.md serves; follows the served text', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.get('/.well-known/agent-skills/index.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const etag = r.headers.get('etag'); assert.ok(etag);
  const j = await r.json();
  assert.equal(j.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  assert.equal(j.skills.length, 1);
  const k = j.skills[0];
  assert.deepEqual(Object.keys(k).sort(), ['description', 'digest', 'name', 'type', 'url']);
  assert.match(k.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/); assert.ok(k.name.length <= 64);
  assert.equal(k.type, 'skill-md');
  assert.ok(k.description.length > 0 && k.description.length <= 1024);
  assert.equal(k.url, `${ORIGIN}/SKILL.md`);
  assert.match(k.digest, /^sha256:[0-9a-f]{64}$/);
  const served = Buffer.from(await (await s.get('/SKILL.md')).arrayBuffer());
  assert.equal(k.digest, `sha256:${crypto.createHash('sha256').update(served).digest('hex')}`, 'the digest is of the bytes /SKILL.md actually serves');
  assert.equal(k.description, 'Crypto market data and checks for AI agents, paid per call in USDC over x402, no API key.', 'the frontmatter description');
  assert.equal(k.name, 'agentfeed', 'the frontmatter name');
  assert.equal((await s.get('/.well-known/agent-skills/index.json', { 'if-none-match': etag, 'cache-control': 'max-age=0' })).status, 304);
  // control: when the served text changes, the digest changes with it and the ETag no longer matches
  skillNow = SKILL + 'one more line\n';
  t.after(() => { skillNow = SKILL; });
  const r2 = await s.get('/.well-known/agent-skills/index.json', { 'if-none-match': etag, 'cache-control': 'max-age=0' });
  assert.equal(r2.status, 200);
  const served2 = Buffer.from(await (await s.get('/SKILL.md')).arrayBuffer());
  assert.equal((await r2.json()).skills[0].digest, `sha256:${crypto.createHash('sha256').update(served2).digest('hex')}`);
  assert.notEqual(k.digest, (await (await s.get('/.well-known/agent-skills/index.json')).json()).skills[0].digest, 'control: the two texts hash differently');
});

// ---- /auth.md ---------------------------------------------------------------------------------------------------------------------------------------
test('/auth.md: short markdown, no registration, x402 or MPP per call or a prepaid key or pass at /api/keys/*, links to llms.txt and openapi.json; ETag, 304, no-cache', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.get('/auth.md');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const etag = r.headers.get('etag'); assert.ok(etag);
  const text = await r.text();
  assert.ok(text.length < 3000, `${text.length} chars: short`);
  assert.equal(text.split('\n')[0], '# auth.md', 'R18: the first line is the H1 the scanner wants (a heading containing auth.md)');
  assert.equal((text.match(/^# /gm) || []).length, 1, 'one H1');
  assert.match(text, /no registration, no account and no API key/i);
  assert.match(text, /x402/); assert.match(text, /MPP/);
  assert.match(text, /\/api\/keys\/balance/);
  assert.ok(text.includes(`${ORIGIN}/llms.txt`) && text.includes(`${ORIGIN}/openapi.json`));
  for (const route of ['/api/keys/buy-1', '/api/keys/buy-day-pass', '/api/keys/buy-pass']) assert.ok(text.includes(`\`${route}\``), route);
  assert.ok(!text.includes('/api/keys/topup-5'), 'only the buy routes are listed, read from the price table');
  assert.ok(text.includes('$25') && text.includes('$1'));
  assert.equal((await s.get('/auth.md', { 'if-none-match': etag, 'cache-control': 'max-age=0' })).status, 304);
});

// ---- robots.txt ------------------------------------------------------------------------------------------------------------------------------------
test('robots.txt: Content-Signal inside the User-agent group, the Agentmap directive, Allow and Sitemap kept', async (t) => {
  const s = await boot(); t.after(s.close);
  const text = await (await s.get('/robots.txt')).text();
  const lines = text.split('\n');
  assert.equal(lines[0], 'User-agent: *');
  assert.equal(lines[1], 'Content-Signal: search=yes, ai-input=yes, ai-train=yes', 'inside the group, right under the User-agent line');
  assert.ok(lines.includes('Allow: /'));
  assert.ok(lines.includes(`Agentmap: ${ORIGIN}/.well-known/ard.json`), 'the ARD spec robots.txt directive');
  assert.ok(lines.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
  assert.ok(lines.indexOf(`Agentmap: ${ORIGIN}/.well-known/ard.json`) > lines.indexOf('Allow: /'), 'Agentmap sits after the group, like Sitemap');
});

// ---- rate-limit class -------------------------------------------------------------------------------------------------------------------------------
test('the new documents are in the docs rate bucket, not the data one', () => {
  for (const p of ['/.well-known/ard.json', '/.well-known/ai-catalog.json', '/.well-known/api-catalog', '/.well-known/agent-skills/index.json', '/auth.md']) assert.ok(DOC_PATH.test(p), p);
  for (const p of ['/.well-known/agent-skills/other.json', '/auth.md.bak', '/api/keys/buy-1', '/.well-known/oauth-protected-resource']) assert.equal(DOC_PATH.test(p), false, p);
});

test('R18 robots.txt: Cache-Control no-cache and an ETag like the other discovery documents; a conditional GET is a 304; the body is unchanged', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await s.get('/robots.txt');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-cache', 'it was public, max-age=3600, and Cloudflare kept the pre-R17 copy for hours');
  const etag = r.headers.get('etag'); assert.ok(etag, 'an ETag');
  const body = await r.text();
  assert.equal(body, compat.ROBOTS, 'the same text as before');
  const again = await s.get('/robots.txt', { 'if-none-match': etag, 'cache-control': 'max-age=0' });
  assert.equal(again.status, 304, 'a revalidation is a 304');
  assert.equal(again.headers.get('cache-control'), 'no-cache');
  assert.equal((await s.get('/robots.txt', { 'if-none-match': 'W/"stale"', 'cache-control': 'max-age=0' })).status, 200, 'a stale ETag gets the full file (control)');
});
