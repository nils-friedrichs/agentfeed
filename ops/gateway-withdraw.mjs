// ops/gateway-withdraw.mjs <cold-address> [--send] [--max-fee 0.05] — sweep the Gateway seller
// balance to cold storage (R5 A2).
//
// Gateway nanopayments credit the Gateway balance of the seller address (payTo of every Gateway
// accept: /root/.config/agentfeed/gateway-seller.key), per chain. Only that key can move it: it
// signs a BurnIntent off-chain, Gateway returns an attestation, and the same account calls
// gatewayMint on the destination chain, so that chain needs a little native gas at the seller
// address (Arc: USDC is the gas token). Same-chain withdrawals pay Circle's burn gas fee
// (Base $0.01, Polygon $0.0015, Arbitrum $0.01, Arc $0.0035, docs Oct 12); --max-fee caps it
// (the SDK's default cap is 2.01 USDC, so it is always passed).
// Dry run by default: prints each chain's available and pending balance and what would move.
// The key is read, never printed.
import fs from 'node:fs';
import { isAddress } from 'viem';
import { GatewayClient } from '@circle-fin/x402-batching/client';

const args = process.argv.slice(2);
const cold = args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const send = args.includes('--send');
const maxFee = (() => { const i = args.indexOf('--max-fee'); return i >= 0 ? args[i + 1] : '0.05'; })();
if (!cold || !isAddress(cold)) { console.error('usage: node ops/gateway-withdraw.mjs <cold-address> [--send] [--max-fee 0.05]'); process.exit(2); }
const key = fs.readFileSync(process.env.GATEWAY_SELLER_KEY || '/root/.config/agentfeed/gateway-seller.key', 'utf8').trim();
let total = 0;
for (const chain of ['base', 'polygon', 'arbitrum', 'arc']) {
  const client = new GatewayClient({ chain, privateKey: key });
  const b = await client.getBalances();
  const g = b.gateway || {};
  const available = Number(g.formattedAvailable ?? 0);
  console.log(`${chain}: seller ${client.address} gateway available ${g.formattedAvailable ?? '0'} USDC, pending ${g.formattedPendingBatch ?? g.pendingBatch ?? '0'}`);
  if (!(available > Number(maxFee))) continue;
  total += available;
  const amount = (available - Number(maxFee)).toFixed(6);
  if (!send) { console.log(`  would withdraw ${amount} USDC to ${cold} on ${chain} (max fee ${maxFee})`); continue; }
  const r = await client.withdraw(amount, { recipient: cold, maxFee });
  console.log(`  withdrew ${r.formattedAmount} USDC on ${r.destinationChain} to ${r.recipient}: mint tx ${r.mintTxHash}`);
}
if (!send) console.log(`dry run: ${total.toFixed(6)} USDC available in total; add --send to withdraw`);
