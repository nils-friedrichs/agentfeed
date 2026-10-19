#!/usr/bin/env node
// ops/discovery-check.mjs <base-url> [--against <other-url>] — R15b: the new discovery paths answer, the paths left alone still 404,
// the three free routes carry `related`, and (with --against) no paid route changed: the manifest of <base-url> and <other-url> agree on
// every route's price and accepts. Read-only GETs; nothing is paid. Exit 0 only if everything holds.
//
//   node ops/discovery-check.mjs http://127.0.0.1:3998 --against https://x402.ochinimus.app     the staged server against live
//   node ops/discovery-check.mjs https://x402.ochinimus.app                                      live, after the deploy
import crypto from 'node:crypto';

const BASE = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(BASE)) { console.error('usage: node ops/discovery-check.mjs <base-url> [--against <other-url>]'); process.exit(2); }
const i = process.argv.indexOf('--against');
const OTHER = i > 0 ? process.argv[i + 1].replace(/\/$/, '') : null;
// a distinct address per run, so a rate bucket of an earlier check cannot answer 429 here (the server reads CF-Connecting-IP)
const IP = `198.51.100.${1 + (crypto.randomBytes(1)[0] % 250)}`;
const HDR = { 'cf-connecting-ip': IP };   // only sent to a local server: Cloudflare answers 403 to a request that carries this header itself
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };
const get = async (base, p) => { const r = await fetch(base + p, { headers: base.startsWith('http://') ? HDR : {} }); const body = await r.text(); return { r, body, type: r.headers.get('content-type') || '' }; };
const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

const JSON_PATHS = ['/x402-resources', '/.well-known/x402-resources', '/.well-known/x402-services.json', '/x402', '/swagger.json', '/api', '/api/',
  '/.well-known/ai-plugin.json', '/.well-known/agents.json', '/.well-known/agent-registration.json'];
const bodies = {};
for (const p of JSON_PATHS) {
  const g = await get(BASE, p);
  bodies[p] = json(g.body);
  ok(g.r.status === 200 && /^application\/json/.test(g.type) && bodies[p] !== undefined, `${p}: 200, ${g.type.split(';')[0]}, ${g.body.length} bytes, parses`);
}
const sec = await get(BASE, '/.well-known/security.txt');
ok(sec.r.status === 200 && sec.type === 'text/plain; charset=utf-8' && /^Contact: https:\/\/github\.com\/seekdaseek\/agentfeed\/security\nExpires: \d{4}-\d\d-\d\dT[\d:]+Z\nCanonical: /.test(sec.body), '/.well-known/security.txt: 200, text/plain; charset=utf-8, Contact, Expires, Canonical');

// the aliases are the documents they alias
const wk = await get(BASE, '/.well-known/x402'); const oa = await get(BASE, '/openapi.json');
for (const p of ['/x402-resources', '/.well-known/x402-resources', '/.well-known/x402-services.json', '/x402']) ok(JSON.stringify(bodies[p]) === JSON.stringify(json(wk.body)) && bodies[p] && bodies[p].resources, `${p} equals /.well-known/x402 (${(bodies[p] && bodies[p].resources || []).length} resources)`);
ok(JSON.stringify(bodies['/swagger.json']) === JSON.stringify(json(oa.body)), '/swagger.json equals /openapi.json');
const api = bodies['/api'];
ok(api && api.name === 'AgentFeed' && api.trading_loop && api.trading_loop.length === 10 && Object.keys(api.links).length === 7, '/api: name, 7 links, 10 trading-loop routes');
ok(JSON.stringify(bodies['/api']) === JSON.stringify(bodies['/api/']), '/api/ is the same document');

// left alone: these must keep answering 404 (or whatever they answered before), not be turned into documents
for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/supported', '/x402/supported', '/api/supported', '/facilitator/supported',
  '/.well-known/did.json', '/ard.json', '/.well-known/x402.sig', '/owners.json']) {
  const g = await get(BASE, p);
  ok(g.r.status === 404, `${p}: still ${g.r.status} (left alone)`);
}
const tg = await get(BASE, '/telegraph/api/token-risk');
ok(tg.r.status === 404, `/telegraph/api/token-risk: still ${tg.r.status} (removed 19 Sep, left alone)`);

// the free routes carry related
for (const [p, tool, max] of [['/api/fear-greed', 'get_fear_greed', 2], ['/api/last-liquidation', 'get_last_liquidation', 2], ['/api/exit-method', 'get_exit_method', 2]]) {
  const g = await get(BASE, p); const j = json(g.body);
  const rel = j && j.data && j.data.related;
  ok(g.r.status === 200 && j.tool === tool && j.paid === false && Array.isArray(rel) && rel.length >= 1 && rel.length <= max
    && rel.every((x) => JSON.stringify(Object.keys(x)) === '["tool","path","price_usd","adds"]' && typeof x.price_usd === 'number'), `${p}: 200, free, related has ${rel ? rel.length : '-'} item(s) of tool/path/price_usd/adds`);
  if (rel) console.log('     ' + rel.map((x) => `${x.path} $${x.price_usd}`).join(', '));
}
// and a paid route's answer carries none
const mk = await get(BASE, '/api/market-snapshot');
ok(mk.r.status === 402, '/api/market-snapshot (paid) still answers 402');

if (OTHER) {
  // per route: price, name and every accept, with extra.feePayer (the facilitator's signer, which rotates per boot) left out
  const norm = (r) => ({ resource: r.resource, price_usd: r.price_usd, name: r.name, accepts: (r.accepts || []).map((a) => { const { extra, ...rest } = a; const { feePayer, ...ex } = extra || {}; return { ...rest, extra: ex }; }) });
  const fetchManifest = async (base) => { for (let n = 0; n < 4; n++) { const g = await get(base, '/.well-known/x402.json'); const j = json(g.body); if (g.r.status === 200 && j && Array.isArray(j.resources)) return j; await new Promise((r) => setTimeout(r, 1500)); } return null; };
  const a = await fetchManifest(BASE), b = await fetchManifest(OTHER);
  if (!a || !b) ok(false, `no paid route changed: a manifest did not load (${BASE}: ${a ? 'ok' : 'no'}, ${OTHER}: ${b ? 'ok' : 'no'})`);
  else {
    const byUrl = (m) => new Map(m.resources.map((r) => [r.resource, JSON.stringify(norm(r))]));
    const ma = byUrl(a), mb = byUrl(b);
    const diff = [...new Set([...ma.keys(), ...mb.keys()])].filter((u) => ma.get(u) !== mb.get(u));
    ok(diff.length === 0 && ma.size === mb.size, `no paid route changed: ${ma.size} routes against ${mb.size} on ${OTHER}, prices and accepts equal (extra.feePayer ignored)${diff.length ? '; differ: ' + diff.slice(0, 5).join(', ') : ''}`);
  }
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed; nothing was paid');
process.exit(failed ? 1 : 0);
