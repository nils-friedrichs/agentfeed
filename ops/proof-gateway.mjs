// ops/proof-gateway.mjs <url> <key-file> [--deposit 0.05] [--dry] — one Circle Gateway nanopayment
// on Base (R5 A2 proof). A Gateway buyer pays from its Gateway balance, so it first deposits
// USDC into the GatewayWallet once (--deposit: an approve + deposit transaction on Base, which
// needs a little ETH for gas at the payer). Before anything is signed, the unpaid 402's Base
// Gateway accept must pay our Gateway seller address. Never prints the key.
import fs from 'node:fs';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const args = process.argv.slice(2);
const [url, keyFile] = args;
const dry = args.includes('--dry');
const dep = (() => { const i = args.indexOf('--deposit'); return i >= 0 ? args[i + 1] : null; })();
const SELLER = '0xa853129acf56a851f9d51cd8cb47619465260fa9';
const r0 = await fetch(url);
const pr = JSON.parse(Buffer.from(r0.headers.get('payment-required') || '', 'base64').toString() || 'null');
const a = pr && pr.accepts.find((x) => x.network === 'eip155:8453' && x.extra && x.extra.name === 'GatewayWalletBatched');
if (!(r0.status === 402 && a && a.payTo.toLowerCase() === SELLER)) { console.log('GUARD FAIL: no Base Gateway accept paying our seller; nothing signed'); process.exit(3); }
const client = new GatewayClient({ chain: 'base', privateKey: fs.readFileSync(keyFile, 'utf8').trim() });
const b = await client.getBalances();
console.log(`payer ${client.address} Base wallet USDC ${b.wallet ? b.wallet.formatted : '?'} | Gateway available ${b.gateway ? b.gateway.formattedAvailable : '?'} | price ${Number(a.amount) / 1e6} USDC`);
if (dry) { console.log(`dry run: would ${dep ? `deposit ${dep} USDC, then ` : ''}pay once; nothing signed`); process.exit(0); }
if (dep) { const d = await client.deposit(dep); console.log(`deposited ${d.formattedAmount ?? dep} USDC: tx ${d.depositTxHash ?? d.txHash ?? JSON.stringify(d).slice(0, 120)}`); }
const res = await client.pay(url);
console.log(`paid ${res.formattedAmount} USDC; status ok; transaction ${res.transaction ?? '-'}; data ${JSON.stringify(res.data).slice(0, 120)}`);
