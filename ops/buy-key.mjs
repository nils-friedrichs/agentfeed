#!/usr/bin/env node
// ops/buy-key.mjs — buy (or top up) an AgentFeed prepaid key with one x402 payment, the key_hash way (R9).
//
// The key is generated HERE, written to --key-out (mode 600) BEFORE anything is paid, and only its sha256 is sent:
// the server never sees the key until its first use, and a connection that drops after settlement loses nothing.
// Nothing prints the key: output names its prefix (the 8 characters after afk_) and its length only.
//
//   node ops/buy-key.mjs --pack trial --chain solana --payer payer-wallet.json --key-out /root/af-trial.key
//   node ops/buy-key.mjs --pack 1 --chain base --payer /root/.config/agentfeed/proof-payer-evm.key --key-out ~/af.key
//   node ops/buy-key.mjs --topup 5 --key-file ~/af.key --chain base --payer <evm key file>
//   add --dry-run to read the 402 and print what would be paid, without paying
// --base defaults to https://x402.ochinimus.app. Packs: trial $0.25, 1, 5, 20. Top-ups: 5, 20.
import fs from 'node:fs';
import crypto from 'node:crypto';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const die = (m) => { console.error(m); process.exit(1); };
const BASE = arg('--base', 'https://x402.ochinimus.app');
const chain = arg('--chain', 'solana');
const payerFile = arg('--payer');
const dry = has('--dry-run');
const PACKS = { trial: 0.25, 1: 1, 5: 5, 20: 20 };
const TOPUPS = { 5: 5, 20: 20 };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (buf) => { let x = BigInt('0x' + buf.toString('hex')); let o = ''; while (x > 0n) { o = B58[Number(x % 58n)] + o; x /= 58n; } for (const b of buf) { if (b) break; o = '1' + o; } return o; };
if (!['solana', 'base'].includes(chain)) die('--chain is solana or base');
if (!dry && !payerFile) die('--payer <file> is required (a Solana keypair JSON for solana, a 0x private key file for base)');

let url; let usd; let headers = {}; let keyOut = null; let key = null;
if (arg('--topup')) {
  usd = TOPUPS[arg('--topup')];
  if (!usd) die('--topup is 5 or 20');
  const kf = arg('--key-file');
  if (!kf) die('--topup needs --key-file <the key it credits>');
  key = fs.readFileSync(kf, 'utf8').trim();
  headers = { 'X-AgentFeed-Key': key };
  url = `${BASE}/api/keys/topup-${arg('--topup')}`;
} else {
  const pack = arg('--pack', 'trial');
  usd = PACKS[pack];
  if (!usd) die('--pack is trial, 1, 5 or 20');
  keyOut = arg('--key-out');
  if (!keyOut) die('--key-out <file> is required: the key is written there (mode 600) before anything is paid');
  if (fs.existsSync(keyOut)) die(`${keyOut} exists; refusing to overwrite a key file`);
  key = 'afk_' + base58(crypto.randomBytes(32));
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  url = `${BASE}/api/keys/buy-${pack}?key_hash=${hash}&prefix=${key.slice(4, 12)}`;
}
const prefix = key.slice(4, 12);
const network = chain === 'solana' ? 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' : 'eip155:8453';

// 1. the challenge, read before paying: the amount on our chain must be the pack price, and nothing else is paid
const ch = await fetch(url, { headers });
if (ch.status !== 402) die(`expected a 402 challenge, got ${ch.status}: ${(await ch.text()).slice(0, 300)}`);
const pr = JSON.parse(Buffer.from(ch.headers.get('payment-required'), 'base64').toString('utf8'));
const acc = pr.accepts.find((a) => a.network === network && a.scheme === 'exact');
if (!acc) die(`no exact ${network} accept in the challenge`);
const atomic = Math.round(usd * 1e6);
if (Number(acc.amount) !== atomic) die(`challenge asks ${acc.amount} atomic USDC on ${network}, expected ${atomic}; not paying`);
console.log(`${url.replace(/key_hash=[0-9a-f]+/, 'key_hash=<sha256>')}`);
console.log(`challenge: ${pr.accepts.length} accepts (${[...new Set(pr.accepts.map((a) => a.scheme))].join(', ')}); paying $${usd} exact on ${network} to ${acc.payTo}`);
if (dry) { console.log('dry run: nothing paid, no key file written'); process.exit(0); }

// 2. the key file first, so a payment can never be made for a key we failed to keep
if (keyOut) { fs.writeFileSync(keyOut, key + '\n', { mode: 0o600 }); fs.chmodSync(keyOut, 0o600); console.log(`key written to ${keyOut} (mode 600, ${key.length} chars), prefix ${prefix}`); }

// 3. pay
const { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } = await import('@x402/fetch');
let schemes;
if (chain === 'solana') {
  const { createKeyPairSignerFromBytes } = await import('@solana/kit');
  const { toClientSvmSigner } = await import('@x402/svm');
  const { ExactSvmScheme } = await import('@x402/svm/exact/client');
  const kp = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(payerFile, 'utf8'))));
  console.log(`payer ${kp.address}`);
  schemes = [{ network, client: new ExactSvmScheme(toClientSvmSigner(kp)) }];
} else {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { ExactEvmScheme } = await import('@x402/evm/exact/client');
  const account = privateKeyToAccount(fs.readFileSync(payerFile, 'utf8').trim());
  console.log(`payer ${account.address}`);
  schemes = [{ network, client: new ExactEvmScheme(account) }];
}
const payFetch = wrapFetchWithPaymentFromConfig(fetch, { schemes });
const res = await payFetch(url, { headers });
const sh = res.headers.get('payment-response');
const settled = sh ? decodePaymentResponseHeader(sh) : null;
const body = await res.json().catch(() => ({}));
console.log(`status ${res.status}${settled ? `; settled ${settled.success ? 'OK' : 'FAILED'} tx ${settled.transaction} on ${settled.network}` : ''}`);
const d = body.data || body;
console.log(JSON.stringify({ prefix: d.prefix ?? prefix, credit_usd: d.credit_usd, balance_usd: d.balance_usd, status: d.status, error: body.error }));
if (res.status !== 200 && keyOut) console.log(`not active: ${keyOut} holds a key that was never paid for; delete it`);
