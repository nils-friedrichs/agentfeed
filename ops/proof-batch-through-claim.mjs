// ops/proof-batch-through-claim.mjs <url> <key-file> <calls> [--dry] — a buyer that keeps paying while the claim job runs (R8, 13 Oct 2026).
//
// ONE process, ONE client context (the standard @x402/evm batch client), <calls> paid requests spaced 800 ms apart; after the second the
// real claim job (ops/batch-claim.js, under the cron's lock) is started in the background and the calls go on while it claims and settles.
// It answers the planning chat's question: can a claim run desync a live channel? PASS = every call served, no corrective 402
// (invalid_batch_settlement_evm_cumulative_amount_mismatch) met by the buyer after the warm-up call, the claim job exited 0, and the audit
// table shows no new mismatch row after the warm-up. The warm-up call (call 0, not counted) absorbs the one resync a process with no stored
// context always needs on its first request while a voucher is outstanding.
//
// Cost on 13 Oct: the proof channel has 0.0005 usable, so the first call tops it up by the route's minimum deposit ($0.005, one EIP-3009
// authorization the facilitator submits, no gas, stays in the channel) and each call is 0.0005 to our own treasury.
//   cd /opt/agentfeed && PROOF_KEY=/root/.config/agentfeed/payer-feff.key node ops/proof-batch-through-claim.mjs https://x402.ochinimus.app/api/eth-price /root/.config/agentfeed/payer-feff.key 8
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';
import Database from 'better-sqlite3';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [url, keyFile, n = '8'] = process.argv.slice(2);
const dry = process.argv.includes('--dry');
const MISMATCH = 'invalid_batch_settlement_evm_cumulative_amount_mismatch';
const TREASURY = '0x22db3a9686ee5261e7bf3ed4f91277232e8076e6';
const AUTHORIZER = '0xba3056ec310658e42dfb8a0fa349c5406212be37';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!url || !keyFile) { console.log('usage: node ops/proof-batch-through-claim.mjs <url> <key-file> <calls> [--dry]'); process.exit(2); }

const account = privateKeyToAccount(fs.readFileSync(keyFile, 'utf8').trim());
const r0 = await fetch(url);
const pr = JSON.parse(Buffer.from(r0.headers.get('payment-required') || '', 'base64').toString() || 'null');
const a = pr && pr.accepts.find((x) => x.scheme === 'batch-settlement' && x.network === 'eip155:8453');
const ok = r0.status === 402 && a && a.payTo.toLowerCase() === TREASURY && String(a.extra && a.extra.receiverAuthorizer).toLowerCase() === AUTHORIZER;
if (!ok) { console.log('GUARD FAIL: no Base batch accept paying the treasury with our authorizer; nothing signed', JSON.stringify(a || null).slice(0, 300)); process.exit(3); }
const pub = createPublicClient({ chain: base, transport: http(process.env.RPC || 'https://mainnet.base.org') });
const bal = await pub.readContract({ address: USDC, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [account.address] });
const price = Number(a.amount) / 1e6, minDeposit = Number(a.extra.minDeposit) / 1e6;
const worst = (Number(n) + 1) * price + minDeposit;
console.log(`payer ${account.address} Base USDC ${formatUnits(bal, 6)} | batch price ${price} | min deposit ${minDeposit} | ${Number(n)} measured calls + 1 warm-up | worst-case outflow ${worst.toFixed(4)} USDC`);
if (Number(formatUnits(bal, 6)) < worst) { console.log('STOP: the payer holds less than the worst case; nothing signed'); process.exit(4); }
if (dry) { console.log('dry run: nothing signed; would pay one warm-up call, then the measured calls with the claim job started after the second'); process.exit(0); }

// the buyer's view of the wire: corrective 402s to paid requests
const seen = { corrective: 0 };
const spy = async (input, init) => {
  const h = input instanceof Request ? input.headers : new Headers(init && init.headers);
  const res = await fetch(input, init);
  if (h.get('payment-signature') && res.status === 402) {
    const raw = res.headers.get('payment-required');
    if (raw && JSON.parse(Buffer.from(raw, 'base64').toString()).error === MISMATCH) seen.corrective++;
  }
  return res;
};
const signer = Object.assign(account, { readContract: (args) => pub.readContract(args) });
const pay = wrapFetchWithPaymentFromConfig(spy, { schemes: [{ network: 'eip155:8453', client: new BatchSettlementEvmScheme(signer) }] });
const charged = (res) => { const h = res.headers.get('payment-response'); try { return JSON.parse(Buffer.from(h, 'base64').toString()).extra.channelState.chargedCumulativeAmount; } catch { return '?'; } };

const t0 = Date.now();
console.log('warm-up call (not counted):');
const w = await pay(url);
console.log(`  status ${w.status} charged ${charged(w)} corrective 402s met ${seen.corrective} (the one resync a context-less process needs)`);
if (w.status !== 200) { console.log('STOPPED: the warm-up call did not pay'); process.exit(1); }
const measuredFrom = Date.now();
seen.corrective = 0;

let job = null, jobOut = '', jobStart = 0, jobEnd = 0, jobCode = null;
const rows = [];
for (let i = 1; i <= Number(n); i++) {
  const res = await pay(url);
  rows.push({ i, status: res.status, charged: charged(res), corrective: seen.corrective, at: Date.now() - measuredFrom });
  console.log(`call ${i}: status ${res.status} charged ${rows[i - 1].charged} corrective 402s so far ${seen.corrective} (+${rows[i - 1].at} ms)${job && !jobEnd ? '  [claim job running]' : ''}`);
  if (res.status !== 200) { console.log((await res.text()).slice(0, 300)); break; }
  if (i === 2) { // start the real claim job in the background, under the cron's lock, and keep paying
    jobStart = Date.now() - measuredFrom;
    job = spawn('flock', ['-w', '120', '/var/lock/batch-claim.lock', process.execPath, 'ops/batch-claim.js'], { cwd: ROOT });
    job.stdout.on('data', (d) => { jobOut += d; });
    job.stderr.on('data', (d) => { jobOut += d; });
    job.on('close', (code) => { jobCode = code; jobEnd = Date.now() - measuredFrom; });
  }
  await sleep(800);
}
for (let i = 0; i < 90 && job && jobCode === null; i++) await sleep(1000);
console.log(`claim job: started +${jobStart} ms, ${jobCode === null ? 'DID NOT FINISH' : `finished +${jobEnd} ms, exit ${jobCode}`}`);
console.log(jobOut.split('\n').filter((l) => /claimed|settled|below|FAILED|nothing/.test(l)).map((l) => '  ' + l.replace(/^\S+ /, '')).join('\n') || '  (no claim or settle lines)');
const overlap = rows.filter((r) => r.at >= jobStart && (!jobEnd || r.at <= jobEnd)).length;
console.log(`calls that went out while the claim job was running: ${overlap}`);

// the audit table: a mismatch row after the warm-up would be the server refusing this buyer
await sleep(3000); // the audit log flushes every 2 s
const db = new Database(process.env.AGENTFEED_DB || path.join(ROOT, 'agentfeed.db'), { readonly: true });
const bad = db.prepare("SELECT id, datetime(ts/1000,'unixepoch') t FROM calls WHERE status='payment_refused' AND error_msg LIKE '%cumulative_amount%' AND ts >= ?").all(measuredFrom);
const paid = db.prepare("SELECT COUNT(*) n FROM calls WHERE status='paid' AND ts >= ?").get(t0).n;
db.close();
console.log(`audit table since the warm-up: ${bad.length} mismatch refusal row(s)${bad.length ? ' ' + JSON.stringify(bad) : ''}; paid rows since the start: ${paid}`);
const served = rows.length === Number(n) && rows.every((r) => r.status === 200);
const pass = served && seen.corrective === 0 && jobCode === 0 && bad.length === 0 && overlap >= 1;
console.log(pass
  ? `PASS: ${n} calls served while a claim job ran (${overlap} of them during it), no corrective 402, no mismatch row`
  : `FAIL: served ${served}, corrective 402s ${seen.corrective}, claim job exit ${jobCode}, mismatch rows ${bad.length}, calls during the job ${overlap}`);
process.exit(pass ? 0 : 1);
