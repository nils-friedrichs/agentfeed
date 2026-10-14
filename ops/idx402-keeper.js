#!/usr/bin/env node
// ops/idx402-keeper.js — keep our 402index.io rows right while 402index's Bazaar sync overwrites them (14 Oct 2026).
//
// Why: 402index's Bazaar ingest (src/aggregators/bazaar-utils.js normalizeItem) reads the price only from the x402 v1 field
// accepts[0].maxAmountRequired; our CDP Discovery records are v2 (accepts[].amount), so it yields price_usd null, and the
// upsert in src/aggregators/bazaar.js writes `price_usd = excluded.price_usd` over the price an owner PATCH set, every poll
// (hourly). The same upsert sets provider_deleted = 0, so a soft-deleted row returns while the CDP Bazaar still lists its URL.
// This job reads our x402 AND MPP rows, PATCHes the price (and rails, or MPP asset and network) of every wrong row back, sets
// domain_verified on a row that lacks it (an owner PATCH does: 402index's editService), and DELETEs withdrawn routes' rows again.
// MPP rows: price = the route's x402 price, payment_asset "USDC.e or OUSD", payment_network "Tempo" (as the hl-whales row reads).
// It writes nothing while the listing is right. Upstream fix: ryanthegentry/402index PR #354 (unmerged); issue #346.
//
//   cd /opt/agentfeed && node ops/idx402-keeper.js           reads, then writes only what is wrong
//   DRY=1 node ops/idx402-keeper.js                          prints what it would send, sends nothing
//
// Environment: OPENAPI_URL (default http://127.0.0.1:3006/openapi.json, the live service on the box), TOKEN_FILE (default
// ~/.config/402index/x402.ochinimus.app.token: the owner verification token; it is never printed). Node built-ins only.
// Safety: a failed or short local read (fewer than 80 priced data routes) or a non-200 from 402index prints SKIP and exits 0
// with no write; one write per second; 429 stops the run (Retry-After logged); 403 stops it (TOKEN-REFUSED).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WITHDRAWN } = require('../lib/compat.js');

const DOMAIN = 'x402.ochinimus.app';
const BASE = 'https://402index.io/api/v1';
const RAILS = 'Solana, Base, Polygon, Arbitrum, Arc, Algorand'; // 46 characters, 402index's cap is 50
const MPP_ASSET = 'USDC.e or OUSD';
const MPP_NETWORK = 'Tempo';
const OPENAPI = process.env.OPENAPI_URL || 'http://127.0.0.1:3006/openapi.json';
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(os.homedir(), '.config', '402index', `${DOMAIN}.token`);
const DRY = process.env.DRY === '1';
const MIN_PRICED = 80;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const out = { rows: 0, mpp_rows: 0, mapped: 0, wrong_before: 0, patched: 0, deleted: 0, failed: 0 };
let note = '';
const line = () => console.log(`${stamp()} rows=${out.rows} mpp_rows=${out.mpp_rows} mapped=${out.mapped} wrong_before=${out.wrong_before} patched=${out.patched} deleted=${out.deleted} failed=${out.failed}${DRY ? ' DRY' : ''}${note ? ' ' + note : ''}`);
const skip = (why) => { note = `SKIP ${why}`; line(); process.exit(0); };

async function http(method, url, body) {
  const res = await fetch(url, {
    method, signal: AbortSignal.timeout(30000),
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
  return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
}

// live prices of the data routes, from our own openapi: { '/api/x/{p}': 0.005, ... }
async function livePrices() {
  let spec;
  try {
    const r = await fetch(OPENAPI, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    spec = await r.json();
  } catch { return null; }
  const prices = {};
  for (const [p, v] of Object.entries(spec.paths || {})) {
    const info = v && v.get && v.get['x-payment-info'];
    if (!info || p.startsWith('/api/keys/')) continue; // free routes carry no x-payment-info; key packs are not data routes
    const amt = Number(info.price && info.price.amount);
    if (Number.isFinite(amt) && amt > 0) prices[p] = amt;
  }
  return prices;
}

// our x402 and MPP rows on 402index (every url on our own domain): the same three searches as idx402-r11.py rows()
async function ourRows() {
  const found = new Map();
  for (const q of ['ochinimus', 'agentfeed', DOMAIN]) {
    for (const off of [0, 100, 200]) {
      const r = await http('GET', `${BASE}/services?q=${encodeURIComponent(q)}&limit=100&offset=${off}`);
      if (r.status !== 200) return null;
      const svcs = Array.isArray(r.json.services) ? r.json.services : [];
      for (const s of svcs) if (String(s.url || '').startsWith(`https://${DOMAIN}/`) && (s.protocol === 'x402' || s.protocol === 'MPP')) found.set(s.id, s);
      if (svcs.length < 100) break;
    }
  }
  return [...found.values()];
}

const pathOf = (s) => s.url.split(DOMAIN, 2)[1].split('?')[0];
const escapeRx = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

(async () => {
  const prices = await livePrices();
  if (!prices || Object.keys(prices).length < MIN_PRICED) skip(`local-read (${prices ? Object.keys(prices).length : 'failed'} priced data routes, need ${MIN_PRICED})`);
  // an openapi pattern /api/x/{p} matches both the colon form /api/x/:p and a concrete /api/x/VALUE
  const patterns = Object.entries(prices).map(([p, price]) => ({ p, price, rx: new RegExp('^' + p.split(/\{[^}]+\}/).map(escapeRx).join('[^/]+') + '$') }));
  const withdrawn = new Set(WITHDRAWN);

  const rows = await ourRows();
  if (!rows) skip('402index-read (non-200)');
  out.rows = rows.filter((s) => s.protocol === 'x402').length;
  out.mpp_rows = rows.filter((s) => s.protocol === 'MPP').length;

  let token = null;
  const tokenOf = () => { if (token === null) { try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { token = ''; } } return token; };
  const plan = [];
  for (const s of rows) {
    const p = pathOf(s);
    if (withdrawn.has(p)) { plan.push({ s, p, op: 'DELETE' }); continue; }
    const m = patterns.find((x) => x.rx.test(p));
    if (!m) continue;
    out.mapped++;
    const mpp = s.protocol === 'MPP';
    const priceOk = s.price_usd !== null && s.price_usd !== undefined && Math.abs(Number(s.price_usd) - m.price) < 1e-9;
    const wantAsset = mpp ? MPP_ASSET : null; // x402 rows: the asset is not judged (USDC as the Bazaar and register path write it)
    const wantNetwork = mpp ? MPP_NETWORK : RAILS;
    const assetOk = wantAsset === null || s.payment_asset === wantAsset;
    if (!priceOk || !assetOk || s.payment_network !== wantNetwork || Number(s.domain_verified) !== 1) {
      plan.push({ s, p, op: 'PATCH', price: m.price, asset: mpp ? MPP_ASSET : 'USDC', network: wantNetwork, mpp });
    }
  }
  out.wrong_before = plan.filter((x) => x.op === 'PATCH').length;

  if (DRY) {
    for (const x of plan) console.log(`DRY ${x.op} ${x.s.id} ${x.s.protocol} ${x.p}${x.op === 'PATCH' ? ' price_usd ' + x.price + ' payment_asset ' + JSON.stringify(x.asset) + ' payment_network ' + JSON.stringify(x.network) : ''}`);
    note = `would write ${plan.length}`; line(); return;
  }
  if (plan.length && !tokenOf()) skip(`no-token (${TOKEN_FILE} unreadable)`);

  for (const x of plan) {
    const body = x.op === 'PATCH'
      ? { domain: DOMAIN, verification_token: tokenOf(), price_usd: x.price, payment_asset: x.asset, payment_network: x.network }
      : { domain: DOMAIN, verification_token: tokenOf() };
    const r = await http(x.op, `${BASE}/services/${x.s.id}`, body);
    if (r.status === 429) { note = `STOP 429 Retry-After=${r.retryAfter || 'n/a'}`; line(); process.exit(0); }
    if (r.status === 403) { note = 'STOP TOKEN-REFUSED (403)'; line(); process.exit(0); }
    if (r.status === 200 || r.status === 204) {
      if (x.op === 'PATCH') out.patched++; else { out.deleted++; console.log(`DELETE ${x.s.id} ${x.s.protocol} ${x.p} (withdrawn route re-listed)`); }
    } else { out.failed++; console.log(`${x.op} ${x.s.id} ${x.s.protocol} ${x.p} HTTP ${r.status} ${String(r.json.error || r.json.message || '').slice(0, 120)}`); }
    await sleep(1000);
  }
  line();
})().catch((e) => { out.failed++; note = `ERROR ${String(e && e.message || e).slice(0, 120)}`; line(); process.exit(0); });
