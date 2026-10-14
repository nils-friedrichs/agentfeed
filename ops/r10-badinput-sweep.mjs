// ops/r10-badinput-sweep.mjs <base url> <key file> [out.json] — R10 addendum A1: does any paid route charge for bad input?
//
// For every priced data route in /openapi.json, every identifier-like parameter (symbol, coin, mint, address, wallet, domain,
// doi, ticker, token, email, title, base, ...) is sent once with a bogus value; the route's other required inputs come from its
// published example. The call is paid with a prepaid key (a comp key from ops/key-admin.mjs: credit, not money), so whether it
// was charged is read off the key's balance (GET /api/keys/balance, free) before and after. The key is read from the file and
// sent in a header; it is never printed.
//
// A route FAILS when the bogus value answers 2xx and the balance went down. "empty" flags a 2xx whose data holds no rows.
import fs from 'node:fs';

const [base, keyFile, out] = process.argv.slice(2);
if (!base || !keyFile) { console.error('usage: node ops/r10-badinput-sweep.mjs <base url> <key file> [out.json]'); process.exit(2); }
const KEY = fs.readFileSync(keyFile, 'utf8').trim();
const H = { 'x-agentfeed-key': KEY, accept: 'application/json' };
const ID = /^(symbol|symbols|coin|coins|mint|address|wallet|domain|doi|ticker|token|email|title|base|asset|pair|market|currency|from|to|input_mint|output_mint|target|cik|form|country|dex|venue|chain)$/;
const BOGUS = (name) => (name === 'email' ? 'nope@nope.invalid' : name === 'doi' ? '10.0000/nope-nope' : 'NOPEZZ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const balance = async () => { const r = await fetch(`${base}/api/keys/balance`, { headers: H }); const j = await r.json(); return Math.round(j.balance_usd * 1e6); };
const emptyish = (d) => {
  if (d == null) return true;
  if (Array.isArray(d)) return d.length === 0;
  if (typeof d !== 'object') return false;
  const vals = Object.values(d);
  const arrays = vals.filter(Array.isArray);
  return arrays.length > 0 && arrays.every((a) => a.length === 0);
};

const oa = await (await fetch(`${base}/openapi.json`)).json();
const rows = [];
for (const [tpl, item] of Object.entries(oa.paths)) {
  const op = item.get;
  if (!op || !op['x-payment-info'] || tpl.startsWith('/api/keys/')) continue;
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(tpl)) continue;
  const params = (op.parameters || []).filter((p) => (p.in === 'path' || p.in === 'query') && ID.test(p.name));
  if (!params.length) continue;
  const exQ = op['x-example-query'] || {}, exP = op['x-example-path'] || {};
  for (const p of params) {
    const pathVals = { ...exP }; const q = { ...exQ };
    if (p.in === 'path') pathVals[p.name] = BOGUS(p.name); else q[p.name] = BOGUS(p.name);
    let path = tpl; for (const [k, v] of Object.entries(pathVals)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    if (/\{/.test(path)) continue;
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    const b0 = await balance();
    const r = await fetch(url, { headers: H });
    let j = null; try { j = await r.json(); } catch { j = null; }
    await sleep(300);
    const b1 = await balance();
    const charged = b0 - b1;
    const row = { route: tpl, param: `${p.in}:${p.name}`, value: BOGUS(p.name), status: r.status, charged_micro: charged, empty: r.ok ? emptyish(j && j.data) : null, error: !r.ok && j ? String(j.error || '').slice(0, 120) : null };
    row.verdict = r.ok && charged > 0 ? 'CHARGED' : r.ok ? 'free-2xx' : 'refused';
    rows.push(row);
    console.log(`${row.verdict.padEnd(8)} ${String(r.status).padEnd(4)} ${String(charged).padStart(6)}µ ${row.empty ? 'EMPTY ' : '      '}${tpl} ${row.param}=${row.value}${row.error ? `  (${row.error.slice(0, 70)})` : ''}`);
    await sleep(1600); // three requests per parameter; the key's own bucket is 120 a minute
  }
}
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => r.verdict === 'CHARGED');
console.log(`DONE ${rows.length} calls: ${bad.length} charged a bogus value (${bad.filter((r) => r.empty).length} with an empty answer), ${rows.filter((r) => r.verdict === 'refused').length} refused`);
