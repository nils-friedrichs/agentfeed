// R15d (19 Oct 2026): the five documents server.js serves itself say Cache-Control: no-cache, and the ETag Express adds keeps a conditional GET a 304.
// The routes below have the shapes server.js gives them (res.json, res.type().send for text and markdown, an async handler for the manifest), behind the
// real middleware and path list from lib/discovery-aliases.js; the order in server.js (middleware ahead of every one of the five routes) is pinned from its source.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const A = require('../lib/discovery-aliases');

const BODY = { openapi: '3.1.0', paths: { '/x': {} } };
async function boot(body = BODY) {
  const app = express();
  app.get(A.NO_CACHE_DOC_PATHS, A.docNoCache);                       // as server.js mounts it
  app.get('/openapi.json', (_req, res) => res.json(body));
  app.get('/.well-known/x402', (_req, res) => res.json({ version: 1, resources: ['a'] }));
  app.get('/llms.txt', (_req, res) => res.type('text/plain; charset=utf-8').send('# AgentFeed\nline\n'));
  app.get('/SKILL.md', (_req, res) => res.type('text/markdown; charset=utf-8').send('# skill\n'));
  app.get('/.well-known/x402.json', async (_req, res) => { await new Promise((r) => setImmediate(r)); res.json({ x402Version: 2, resources: [] }); });
  app.get('/other', (_req, res) => res.json({ untouched: true }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  // fetch() adds Cache-Control: no-cache to a request with If-None-Match, which makes Express answer 200; max-age=0 is an ordinary revalidation
  return { get: (p, h = {}) => fetch(base + p, { headers: h }), close: () => srv.close() };
}

test('the five paths: 200, Cache-Control no-cache, an ETag, and a conditional GET with it is a 304 with no body (one test per path)', async (t) => {
  assert.deepEqual([...A.NO_CACHE_DOC_PATHS].sort(), ['/.well-known/x402', '/.well-known/x402.json', '/SKILL.md', '/llms.txt', '/openapi.json']);
  const s = await boot(); t.after(s.close);
  for (const p of A.NO_CACHE_DOC_PATHS) {
    await t.test(p, async () => {
      const r = await s.get(p);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      const etag = r.headers.get('etag');
      assert.ok(etag, 'an ETag');
      const body = await r.text();
      assert.ok(body.length > 0);
      const again = await s.get(p, { 'if-none-match': etag, 'cache-control': 'max-age=0' });
      assert.equal(again.status, 304, 'a revalidation is a 304');
      assert.equal(again.headers.get('cache-control'), 'no-cache', 'the 304 repeats the directive');
      assert.equal(await again.text(), '');
      assert.equal((await s.get(p, { 'if-none-match': 'W/"stale"', 'cache-control': 'max-age=0' })).status, 200, 'another ETag is a full 200 (control: the 304 is not unconditional)');
    });
  }
});

test('a changed document changes its ETag, so a client holding the old one gets the new body (the /api case)', async (t) => {
  const a = await boot({ openapi: '3.1.0', v: 1 }); t.after(a.close);
  const b = await boot({ openapi: '3.1.0', v: 2 }); t.after(b.close);
  const old = (await a.get('/openapi.json')).headers.get('etag');
  const r = await b.get('/openapi.json', { 'if-none-match': old, 'cache-control': 'max-age=0' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).v, 2);
});

test('only those paths: other routes get no Cache-Control from the middleware', async (t) => {
  const s = await boot(); t.after(s.close);
  assert.equal((await s.get('/other')).headers.get('cache-control'), null);
});

test('server.js mounts the middleware ahead of every one of the five routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const mount = src.indexOf('app.get(A.NO_CACHE_DOC_PATHS, A.docNoCache)');
  assert.ok(mount > 0, 'server.js mounts docNoCache on NO_CACHE_DOC_PATHS');
  for (const route of ["app.get('/openapi.json'", "app.get('/.well-known/x402'", "app.get('/llms.txt'", "app.get('/SKILL.md'", "app.get('/.well-known/x402.json'"]) {
    const at = src.indexOf(route);
    assert.ok(at > 0, `${route} is in server.js`);
    assert.ok(mount < at, `the middleware comes before ${route}`);
  }
});
