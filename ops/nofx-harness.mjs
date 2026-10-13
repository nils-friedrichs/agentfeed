#!/usr/bin/env node
// ops/nofx-harness.mjs — does exactly what NOFX does with an External Data Source, against our routes (R9 K4 proof).
//
// Replicates github.com/NoFxAiOS/nofx at ef476f2 (dev HEAD on 13 Oct 2026), kernel/engine.go L980-1039:
//   fetchSingleExternalSource: security.ValidateURL(url) (http or https, host must not resolve to a private address);
//     timeout = refresh_secs seconds, 30 s when 0; http.NewRequest(method, url, nil) with an empty method meaning GET
//     and no body; req.Header.Set for every header; client.Do; io.ReadAll with no size limit; the HTTP status is NOT
//     checked; json.Unmarshal(body, &interface{}) (a body that is not JSON is an error and the source is skipped);
//     then extractJSONPath(result, data_path) when data_path is set.
//   extractJSONPath: split on ".", step into maps only; a missing key or a non-map (an array included) gives nil.
//   FetchExternalData: results keyed by source name; a failed source is logged and skipped.
// NOTE: at ef476f2 nothing calls FetchExternalData (git grep: its only occurrences are its definition), so stock
// NOFX never fetches these sources. This harness proves our answers are what that code would read once it is wired.
//
//   node ops/nofx-harness.mjs --key-file /root/r9-proof.key [--base https://x402.ochinimus.app] [--coin BTC]
// The key is read from the file and never printed; output names the prefix only.
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'https://x402.ochinimus.app');
const COIN = arg('--coin', 'BTC');
const keyFile = arg('--key-file');
if (!keyFile) { console.error('usage: nofx-harness.mjs --key-file <file> [--base URL] [--coin BTC]'); process.exit(1); }
const KEY = fs.readFileSync(keyFile, 'utf8').trim();

// The two entries docs/nofx.md tells a user to paste, verbatim apart from the key.
const SOURCES = [
  { name: 'agentfeed_board', type: 'api', url: `${BASE}/api/signal-board?n=30`, method: 'GET', headers: { 'X-AgentFeed-Key': KEY }, data_path: 'data', refresh_secs: 20 },
  { name: `agentfeed_${COIN.toLowerCase()}`, type: 'api', url: `${BASE}/api/coin-signal/${COIN}`, method: 'GET', headers: { 'X-AgentFeed-Key': KEY }, data_path: 'data', refresh_secs: 20 },
];

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const s = ip.toLowerCase();
  return s === '::1' || s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd') || s === '::';
}
async function validateURL(u) { // security/url_validator.go ValidateURL, in substance
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`scheme ${url.protocol} not allowed`);
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)) throw new Error('blocked host');
  let addrs = [];
  try { addrs = await dns.lookup(url.hostname, { all: true }); } catch { return; } // NOFX allows the URL when DNS fails
  if (addrs.some((a) => privateIp(a.address))) throw new Error('resolves to a private address');
}
function extractJSONPath(data, path) {
  let cur = data;
  for (const part of path.split('.')) {
    if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) cur = cur[part];
    else return null;
  }
  return cur === undefined ? null : cur; // a missing map key is Go's nil
}
async function fetchSingleExternalSource(src) {
  if (!process.env.NOFX_HARNESS_ALLOW_LOCAL) await validateURL(src.url); // the env var is for a local scratch server only
  const timeoutMs = (src.refresh_secs || 30) * 1000;
  const headers = {};
  for (const [k, v] of Object.entries(src.headers || {})) headers[k] = v;
  const t0 = Date.now();
  const res = await fetch(src.url, { method: src.method || 'GET', headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  const body = await res.text();
  let result = JSON.parse(body); // json.Unmarshal into interface{}; throws on non-JSON like Go returns err
  if (src.data_path) result = extractJSONPath(result, src.data_path);
  return { result, status: res.status, bytes: Buffer.byteLength(body), ms: Date.now() - t0 };
}

const prefix = KEY.slice(4, 12);
console.log(`nofx-harness: base ${BASE}, key prefix ${prefix} (${KEY.length} chars), NOFX ef476f2 semantics`);
const externalData = {};
for (const src of SOURCES) {
  try {
    const r = await fetchSingleExternalSource(src);
    externalData[src.name] = r.result;
    const d = r.result;
    const shape = d && typeof d === 'object' ? Object.keys(d).slice(0, 12).join(',') : String(d);
    console.log(`[${src.name}] HTTP ${r.status} (NOFX ignores the status) ${r.bytes} B in ${r.ms} ms; data_path "${src.data_path}" -> ${d === null ? 'nil' : Array.isArray(d) ? 'array' : typeof d} {${shape}}`);
    if (d && d.coins && d.ranked) {
      const first = d.ranked[0];
      console.log(`  ranked ${d.ranked.length} coins, first ${first}: ${JSON.stringify(d.coins[first])}`);
      console.log(`  walk data.coins.${first}.funding_ann_pct = ${extractJSONPath({ data: d }, `data.coins.${first}.funding_ann_pct`)}`);
    } else if (d && d.coin) {
      console.log(`  ${d.coin}: mark ${d.mark}, flags [${(d.flags || []).join(',')}], cascade_15m ${JSON.stringify(d.cascade_15m)}`);
    } else {
      console.log(`  body: ${JSON.stringify(d).slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`[${src.name}] skipped (NOFX logs "Failed to fetch external data source"): ${String(e.message).slice(0, 200)}`);
  }
}
const prompt = JSON.stringify(externalData);
console.log(`externalData: ${Object.keys(externalData).length} of ${SOURCES.length} sources, ${prompt.length} B as JSON${prompt.includes(KEY) ? ' -- KEY LEAKED INTO THE DATA' : ''}`);
