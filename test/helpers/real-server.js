// test/helpers/real-server.js: boots the REAL, unmodified server.js (the whole middleware stack) in a child process, with a stub facilitator on
// loopback that calls every payment valid and settles it (recording what it was asked), every outbound connection refused and logged
// (af-test-preload.js), and every database pointed at an empty scratch file. Nothing leaves 127.0.0.1. All payTo values are synthetic.
//
// This is what the R19 findings need: both defects are in how server.js composes its middleware, so a test of one module cannot show them.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const BASE = 'eip155:8453';
const PAY_TO = 'So11111111111111111111111111111111111111112';           // a synthetic fixture (the wrapped-SOL mint address), not a treasury
const PAY_TO_EVM = '0x' + '22'.repeat(20);                              // synthetic
const PAYER = '0x' + 'ab'.repeat(20);                                   // synthetic
const FEE_PAYER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';       // a synthetic stub feePayer (the SPL Token program id): any valid public key

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8').replace(/^﻿/, ''));

function startFacilitator() {
  const log = [];
  const kinds = [
    { x402Version: 2, scheme: 'exact', network: SOL, extra: { feePayer: FEE_PAYER } },
    { x402Version: 2, scheme: 'exact', network: BASE },
    { x402Version: 2, scheme: 'exact', network: 'eip155:137' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:42161' },
    { x402Version: 1, scheme: 'exact', network: 'base' },
    { x402Version: 1, scheme: 'exact', network: 'solana', extra: { feePayer: FEE_PAYER } },
  ];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url.endsWith('/supported')) return send({ kinds, extensions: [], signers: {} });
      let j = {};
      try { j = JSON.parse(body); } catch { /* empty */ }
      const reqs = j.paymentRequirements || {};
      const amount = reqs.amount || reqs.maxAmountRequired;
      if (req.url.endsWith('/verify')) { log.push({ op: 'verify', amount, network: reqs.network, v: j.x402Version }); return send({ isValid: true, payer: PAYER }); }
      if (req.url.endsWith('/settle')) { log.push({ op: 'settle', amount, network: reqs.network, v: j.x402Version }); return send({ success: true, transaction: '0x' + '5e'.repeat(32), network: reqs.network, payer: PAYER }); }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, log, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function boot(extraEnv = {}) {
  const fac = await startFacilitator();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afreal-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const netLog = path.join(dir, 'net.log');
  const handlerLog = path.join(dir, 'handlers.log');
  const env = {
    PATH: process.env.PATH, HOME: dir, NODE_ENV: 'test', AF_ROOT: ROOT, AF_NET_LOG: netLog, AF_HANDLER_LOG: handlerLog,
    PORT: String(port), X402_MODE: 'on', X402_NETWORK: 'mainnet', FACILITATOR_URL: fac.url,
    PAY_TO, PAY_TO_EVM, HELIUS_API_KEY: 'dummy-not-a-key', X402_HF: 'off', X402_ARC: 'off', X402_ALGO: 'off', X402_EXT: 'off',
    AGENTFEED_DB: path.join(dir, 'agentfeed.db'), LIQ_DB: path.join(dir, 'liq.db'), PEGWATCH_DB: path.join(dir, 'peg.db'),
    PEG_ONCHAIN_DB: path.join(dir, 'pegon.db'), OVERHANG_DB_PATH: path.join(dir, 'overhang.db'), FUNDING_RADAR_DB: path.join(dir, 'fr.db'),
    BASE_LAUNCHES_DB: path.join(dir, 'bl.db'), CALIPER_RECORD_DB: path.join(dir, 'cal.db'), CALIPER_LIQ_DB: path.join(dir, 'calliq.db'),
    CALIPER_DIR: dir, GEMINI_DATA_DIR: dir, GEMINI_API_KEY: 'dummy-not-a-key', ARC_PENDING_LOG: path.join(dir, 'arc.jsonl'),
    MPP_ENABLED: 'false', ...extraEnv,
  };
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'af-test-preload.js'), path.join(ROOT, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not come up:\n' + out.slice(-3000))), 40000);
    const iv = setInterval(() => { if (/agentfeed up on/.test(out)) { clearInterval(iv); clearTimeout(t); resolve(); } }, 50);
    child.on('exit', (c) => { clearInterval(iv); clearTimeout(t); reject(new Error('server exited ' + c + '\n' + out.slice(-3000))); });
  });
  await new Promise((r) => setTimeout(r, 500)); // x402v1.bind and the manifest
  const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const Database = require('better-sqlite3');
  return {
    port, fac, dir, env, out: () => out,
    handlerRuns: () => lines(handlerLog),
    netAttempts: () => lines(netLog),
    db: () => new Database(env.AGENTFEED_DB, { fileMustExist: true }),
    close: () => { child.kill('SIGKILL'); fac.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A raw HTTP request with the path sent exactly as written (no client-side normalisation). `ip` rotates the rate-limit bucket. */
function raw(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: 'x402.ochinimus.app', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A v2 exact-on-Base payment built from a 402's own challenge (copies the Base accept verbatim). */
function payBase(challengeHeader) {
  const pr = unb64(challengeHeader);
  const accepted = pr.accepts.find((a) => a.network === BASE && a.scheme === 'exact');
  if (!accepted) throw new Error('no base exact accept');
  return { x402Version: 2, resource: pr.resource, accepted, payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: '0x' + '44'.repeat(32) } } };
}

/** An x402 v1 exact-on-base payment for a 5000-atomic route. */
function payV1(extra = {}, value = '5000') {
  return { x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAY_TO_EVM, value, validAfter: '0', validBefore: String(2 ** 40), nonce: '0x' + '33'.repeat(32) } }, ...extra };
}

/** Rows written to the calls table since `sinceId`. logCall batches every 2 s, so wait for the flush. */
async function rowsSince(s, sinceId = 0) {
  await new Promise((r) => setTimeout(r, 2600));
  const d = s.db();
  try { return d.prepare('SELECT id, tool, status, amount_usdc, req_path, method FROM calls WHERE id > ? ORDER BY id').all(sinceId); } finally { d.close(); }
}

module.exports = { boot, raw, payBase, payV1, rowsSince, b64, unb64, SOL, BASE, PAYER, PAY_TO_EVM };
