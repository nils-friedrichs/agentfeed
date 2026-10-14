#!/usr/bin/env node
// ops/circle-key-check.js — does a Circle API key authenticate against Circle's Facilitator Service from THIS box? (R8, 13 Oct 2026)
//
//   cd /opt/agentfeed && node ops/circle-key-check.js           the key in .env (CIRCLE_API_KEY)
//   ssh -t root@167.233.69.154 'cd /opt/agentfeed && node ops/circle-key-check.js --stdin'
//                                                                a CANDIDATE key, typed or pasted at a hidden prompt (-t gives the prompt a terminal; without it the
//                                                                local terminal would echo what you paste). Paste only after the prompt shows. The key is checked
//                                                                from memory and goes nowhere else: .env is not read for it and not written.
//   pbpaste | ssh root@167.233.69.154 'cd /opt/agentfeed && node ops/circle-key-check.js --stdin'     the same, the key piped on stdin
//   node --env-file=<another env file> ops/circle-key-check.js   another env file, e.g. the key being replaced
//
// Read-only and free. Three calls, authenticated exactly as lib/circle-arc.js authenticates verify, settle and status:
//   GET /status/<random uuid>     a valid key gets 404 (no such payment)
//   POST /verify  with {}         a valid key gets 400 (invalid request body)
//   POST /settle  with {}         a valid key gets 400
// A key Circle rejects gets 401, a valid key that may not be used from this address or by this account gets 403, on all three. Circle's
// /supported needs no auth, so the server's startup (and the "Arc rail: ... (api-key)" line) tells nothing about the key; this does.
//
// Never writes anything (not .env, not a log) and never prints the key: the output carries the key's TYPE LABEL when it is TEST_API_KEY or
// LIVE_API_KEY (anything else is described by its length and field count only) and the HTTP statuses; an echo of the key in Circle's answer
// is replaced before printing. The candidate key lives in this process's memory for a second or two.
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* env from the shell or --env-file */ }
const { CircleArcFacilitator } = require('../lib/circle-arc');

const PROBES = [
  { name: 'status', method: 'GET', url: (c) => `${c.url}/status/${crypto.randomUUID()}`, body: null, ok: [200, 404] },
  { name: 'verify', method: 'POST', url: (c) => `${c.url}/verify`, body: {}, ok: [400, 422] },
  { name: 'settle', method: 'POST', url: (c) => `${c.url}/settle`, body: {}, ok: [400, 422] },
];

/** The text safe to print about a key: its type label when it is one of the two Circle types, otherwise only its shape. */
function describeKey(key) {
  if (!key) return '(no key: keyless trial)';
  const fields = key.split(':');
  if (fields.length > 1 && /^(TEST|LIVE)_API_KEY$/.test(fields[0])) return fields[0];
  return `(unrecognised format: ${key.length} characters, ${fields.length} field${fields.length === 1 ? '' : 's'})`;
}

/** What the candidate looks like once a terminal or a pipe has had its way with it: no escape sequences, no quotes, no line ends. */
function cleanKey(raw) {
  return String(raw || '').replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '').replace(/[\r\n]+/g, '').trim().replace(/^CIRCLE_API_KEY\s*=\s*/, '').replace(/^["']+|["']+$/g, '');
}

/** A hidden prompt on a terminal (raw mode: nothing is echoed), or everything on stdin when it is a pipe. */
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; });
      stdin.on('end', () => resolve(buf));
      stdin.on('error', reject);
      return;
    }
    stdin.setRawMode(true);   // before the prompt: whatever is typed once the prompt is visible must already be unechoed
    process.stderr.write(prompt);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = (err) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      if (err) reject(err); else resolve(buf);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function verdictOf(results) {
  const statuses = results.map((r) => r.status);
  if (results.every((r) => r.ok)) return { verdict: 'ACCEPTED', accepted: true };
  if (statuses.includes(401)) return { verdict: 'REJECTED (401: the key itself)', accepted: false };
  if (statuses.includes(403)) return { verdict: 'FORBIDDEN (403: this address, the key\'s access level, or the account)', accepted: false };
  return { verdict: 'UNEXPECTED', accepted: false };
}

(async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('usage: node ops/circle-key-check.js [--stdin]   (see the header of this file)');
    return;
  }
  const fromStdin = process.argv.includes('--stdin');
  let env = process.env;
  if (fromStdin) {
    const candidate = cleanKey(await readSecret('Circle API key (input hidden, then Enter): '));
    if (!candidate) { console.log('no key received'); process.exitCode = 2; return; }
    if (/\s/.test(candidate)) { console.log('the input contains whitespace: paste only the key'); process.exitCode = 2; return; }
    env = { ...process.env, CIRCLE_API_KEY: candidate };
  }
  const c = new CircleArcFacilitator({ env });
  const scrub = (t) => (c.apiKey ? String(t).split(c.apiKey).join('<key>') : String(t)).replace(/\s+/g, ' ').slice(0, 120);
  const results = [];
  for (const p of PROBES) {
    const r = await c.call(p.name, p.method, p.url(c), p.body);
    results.push({ name: p.name, status: r.status, ok: p.ok.includes(r.status), note: r.json ? (r.json.message || '') : r.text });
  }
  const { verdict, accepted } = verdictOf(results);
  const detail = accepted ? '' : ` | Circle says: ${scrub(results.find((r) => !r.ok).note)}`;
  console.log(`mode ${c.mode} | key source ${fromStdin ? 'stdin' : 'env'} | key type ${describeKey(c.apiKey)} | ${c.url} | ${results.map((r) => `${r.name} ${r.status}`).join(' | ')} -> ${verdict}${detail}`);
  process.exitCode = accepted ? 0 : 1;
})().catch((e) => { console.log(`check failed: ${String(e && e.message).slice(0, 160)}`); process.exitCode = 2; });
