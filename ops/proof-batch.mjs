// ops/proof-batch.mjs <url> <key-file> <calls> [--dry] — pay <calls> requests over batch-settlement
// on Base (R5 A1 proof). The first call opens the channel with the route's minimum deposit
// (one EIP-3009 authorization, submitted by the facilitator; the payer needs no ETH), the rest
// are off-chain vouchers. Before anything is signed the unpaid 402's Base batch accept must pay
// the treasury 0x22DB…76e6, name our receiverAuthorizer and carry half the route price.
// Prints each call's status and the channel's charged total; never prints the key.
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const [url, keyFile, n = '5'] = process.argv.slice(2);
const dry = process.argv.includes('--dry');
const TREASURY = '0x22db3a9686ee5261e7bf3ed4f91277232e8076e6';
const AUTHORIZER = '0xba3056ec310658e42dfb8a0fa349c5406212be37';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const account = privateKeyToAccount(fs.readFileSync(keyFile, 'utf8').trim());
const r0 = await fetch(url);
const pr = JSON.parse(Buffer.from(r0.headers.get('payment-required') || '', 'base64').toString() || 'null');
const a = pr && pr.accepts.find((x) => x.scheme === 'batch-settlement' && x.network === 'eip155:8453');
const ok = r0.status === 402 && a && a.payTo.toLowerCase() === TREASURY && String(a.extra && a.extra.receiverAuthorizer).toLowerCase() === AUTHORIZER;
if (!ok) { console.log('GUARD FAIL: no Base batch accept paying the treasury with our authorizer; nothing signed', JSON.stringify(a || null).slice(0, 300)); process.exit(3); }
const pub = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const bal = await pub.readContract({ address: USDC, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [account.address] });
console.log(`payer ${account.address} Base USDC ${formatUnits(bal, 6)} | batch price ${Number(a.amount) / 1e6} USDC | min deposit ${Number(a.extra.minDeposit) / 1e6} USDC | withdrawDelay ${a.extra.withdrawDelay}s`);
if (dry) { console.log(`dry run: would pay ${n} call(s) on the payer's channel (the first call opens it if it does not exist); nothing signed`); process.exit(0); }
const signer = Object.assign(account, { readContract: (args) => pub.readContract(args) });
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new BatchSettlementEvmScheme(signer) }] });
let paid = 0;
for (let i = 1; i <= Number(n); i++) {
  const r = await pay(url);
  const resp = r.headers.get('payment-response');
  const s = resp ? JSON.parse(Buffer.from(resp, 'base64').toString()) : null;
  console.log(`call ${i}: status ${r.status}${s ? ` settled ${s.success} tx ${s.transaction || '-'} charged ${s.extra && s.extra.channelState ? s.extra.channelState.chargedCumulativeAmount : '?'}` : ''}`);
  if (r.status !== 200) { console.log((await r.text()).slice(0, 300)); process.exit(1); }
  paid++;
}
console.log(`done: ${paid} calls paid over batch-settlement`);
