#!/usr/bin/env node
// ops/stock-client-check.mjs <base-url> [path ...] — does a STOCK @x402/fetch client, with DEFAULT settings, buy these routes?
//
//   node ops/stock-client-check.mjs http://127.0.0.1:3998                              the $1 day pass, Base and Solana, plus the controls
//   node ops/stock-client-check.mjs https://x402.ochinimus.app /api/keys/buy-day-pass  another route
//
// "Default settings" means wrapFetchWithPaymentFromConfig(fetch, { schemes }) with NO spendControls, which in @x402/fetch 2.28
// caps a payment at $1 (1,000,000 atomic units: accepted; 1,000,001: refused) and knows only each scheme's default assets.
// SIGNING BUT NOT SENDING: the client fetches the real 402 from <base-url>, builds and signs its payment from throwaway,
// unfunded keys (generated here, never saved), and the paid retry is caught in this process and answered with a stub 200. The
// payment never reaches the server, a facilitator or a chain; the Solana half reads public RPC state only.
//
// Checks per run: for each chain (Base eip155:8453; Solana) the client signs exactly the route's price to the route's own payTo; a
// client registered for both takes the first accept (Solana); and the controls: the same client is refused by its own spend cap on
// the $25 bot pass (/api/keys/buy-pass), before anything is signed. Exit 0 only if all hold.
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { toClientSvmSigner } from '@x402/svm';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import crypto from 'node:crypto';

const BASE_URL = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(BASE_URL)) { console.error('usage: node ops/stock-client-check.mjs <base-url> [path ...]'); process.exit(2); }
const PATHS = process.argv.slice(3).length ? process.argv.slice(3) : ['/api/keys/buy-day-pass'];
const CONTROL = '/api/keys/buy-pass';
const BASE = 'eip155:8453';
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

async function solanaSigner() {
  // a fresh Ed25519 keypair as the 64-byte secret+public layout createKeyPairSignerFromBytes reads; never written anywhere
  const k = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const seed = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey)).slice(-32);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
  return toClientSvmSigner(await createKeyPairSignerFromBytes(Uint8Array.from([...seed, ...pub])));
}

/** a fetch that passes the unpaid request to the server and catches the paid retry instead of sending it */
function catcher(caught) {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const sig = req.headers.get('payment-signature');
    if (!sig) return fetch(req);
    caught.push(unb64(sig));
    return new Response(JSON.stringify({ data: { stub: 'paid retry caught, not sent' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

async function challenge(path) {
  const r = await fetch(BASE_URL + path);
  const h = r.headers.get('payment-required');
  return { status: r.status, pr: h ? unb64(h) : null };
}

for (const path of PATHS) {
  const ch = await challenge(path);
  ok(ch.status === 402 && ch.pr, `${path}: the server answers 402 with a payment-required header`);
  if (!ch.pr) continue;
  const quote = (network) => ch.pr.accepts.find((a) => a.network === network && a.scheme === 'exact');
  const first = ch.pr.accepts[0];
  const runs = [
    ['Base', BASE, async () => [{ network: BASE, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }]],
    ['Solana', SOL, async () => [{ network: 'solana:*', client: new ExactSvmScheme(await solanaSigner()) }]],
    ['Base and Solana registered together (first accept wins)', first.network, async () => [{ network: BASE, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }, { network: 'solana:*', client: new ExactSvmScheme(await solanaSigner()) }]],
  ];
  for (const [name, network, schemes] of runs) {
    const caught = [];
    const pay = wrapFetchWithPaymentFromConfig(catcher(caught), { schemes: await schemes() }); // default settings: no spendControls
    let res, err;
    try { res = await pay(BASE_URL + path); } catch (e) { err = e; }
    const q = quote(network);
    ok(!err && res && res.status === 200 && caught.length === 1, `${path} on ${name}: the client signed one payment${err ? ' (error: ' + String(err.message).slice(0, 110) + ')' : ''}`);
    if (!caught.length || !q) { ok(false, `${path} on ${name}: a payment and a quote to compare`); continue; }
    const a = caught[0].accepted;
    ok(a.network === network && a.amount === q.amount && a.payTo === q.payTo && a.asset === q.asset, `${path} on ${name}: signed ${a.amount} atomic units of ${a.asset.slice(0, 8)}... on ${a.network} to ${a.payTo.slice(0, 8)}..., the route's own quote`);
    ok(BigInt(a.amount) <= 1_000_000n, `${path} on ${name}: ${a.amount} is within the default $1 cap`);
  }
}

// controls: the same default client is refused on the $25 pass by its own spend cap, before it signs anything
for (const [name, schemes] of [['Base', () => [{ network: BASE, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }]], ['Solana', async () => [{ network: 'solana:*', client: new ExactSvmScheme(await solanaSigner()) }]]]) {
  const ch = await challenge(CONTROL);
  if (!ch.pr) { ok(false, `control ${CONTROL}: no 402 to test against`); continue; }
  const caught = [];
  const pay = wrapFetchWithPaymentFromConfig(catcher(caught), { schemes: await schemes() });
  let err = null;
  try { await pay(BASE_URL + CONTROL); } catch (e) { err = e; }
  ok(err && /spendControls\.maxAmountPerPayment \(\$1/.test(String(err.message)) && caught.length === 0, `control ${CONTROL} on ${name}: refused by the client's default $1 cap, nothing signed`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed; nothing was sent');
process.exit(failed ? 1 : 0);
