// ops/proof-gateway.mjs <url> <key-file> [--deposit 0.05|auto] [--dry] — one Circle Gateway nanopayment.
// CHAIN=base (default) or CHAIN=arc picks the chain the payer deposits on and pays from (R5 A2 proof on Base;
// R7: Arc mainnet 5042, where gas is paid in USDC and a proof costs cents).
// A Gateway buyer pays from its Gateway balance, so it first deposits USDC into the GatewayWallet once
// (--deposit: an approve + deposit transaction pair, which needs gas at the payer: ETH on Base, USDC on Arc).
// `--deposit auto` sizes the deposit from a LIVE gas estimate so the approve, the deposit and a couple of payments
// all fit in what the payer holds; a number is used as given. Before anything is signed, the unpaid 402's Gateway
// accept on the chosen network must pay our Gateway seller address. Never prints the key.
import fs from 'node:fs';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { encodeFunctionData, parseAbi } from 'viem';

const NETS = {
  base: { id: 'eip155:8453', label: 'Base', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  arc: { id: 'eip155:5042', label: 'Arc', usdc: '0x3600000000000000000000000000000000000000' },
};
const CHAIN = (process.env.CHAIN || 'base').toLowerCase();
if (!NETS[CHAIN]) { console.log(`CHAIN must be base or arc, got ${CHAIN}`); process.exit(2); }
const NET = NETS[CHAIN];
const GATEWAY_WALLET = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE';
const SELLER = '0xa853129acf56a851f9d51cd8cb47619465260fa9';

const args = process.argv.slice(2);
const [url, keyFile] = args;
const dry = args.includes('--dry');
const dep = (() => { const i = args.indexOf('--deposit'); return i >= 0 ? args[i + 1] : null; })();

const r0 = await fetch(url);
const pr = JSON.parse(Buffer.from(r0.headers.get('payment-required') || '', 'base64').toString() || 'null');
const a = pr && pr.accepts.find((x) => x.network === NET.id && x.extra && x.extra.name === 'GatewayWalletBatched');
if (!(r0.status === 402 && a && a.payTo.toLowerCase() === SELLER)) { console.log(`GUARD FAIL: no ${NET.label} (${NET.id}) Gateway accept paying our seller; nothing signed`); process.exit(3); }
const price = BigInt(a.amount); // 6-decimal USDC units

const client = new GatewayClient({ chain: CHAIN, privateKey: fs.readFileSync(keyFile, 'utf8').trim() });
const b = await client.getBalances();
const walletUnits = b.wallet && b.wallet.balance != null ? BigInt(b.wallet.balance) : null; // USDC the payer holds on this chain
console.log(`chain ${CHAIN} | payer ${client.address} wallet USDC ${b.wallet ? b.wallet.formatted : '?'} | Gateway available ${b.gateway ? b.gateway.formattedAvailable : '?'} | price ${Number(price) / 1e6} USD`);

// ---- deposit sizing from a live gas estimate (Arc and Base alike) ----
let depositStr = dep;
if (dep === 'auto') {
  const pc = client.publicClient;
  const gasPrice = await pc.getGasPrice();
  const approveData = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [GATEWAY_WALLET, 10_000n] });
  const gApprove = await pc.estimateGas({ account: client.address, to: NET.usdc, data: approveData });
  const gDeposit = 120_000n;                                   // the gas limit GatewayClient.deposit() sets on the deposit transaction itself
  const feeWei = ((gApprove + gDeposit) * gasPrice * 3n) / 2n; // 1.5x for price drift between now and the transaction
  const feeUnits = CHAIN === 'arc' ? (feeWei + 10n ** 12n - 1n) / 10n ** 12n : 0n; // Arc: gas is paid in the same USDC (18 decimals native, 6 as a token)
  const payBudget = price * 4n;                                // a few payments
  if (walletUnits == null) { console.log('cannot read the wallet balance; nothing signed'); process.exit(4); }
  // On Arc the fee comes out of the same USDC the deposit comes from; on Base gas is ETH and only the USDC side limits it
  const room = walletUnits - feeUnits;
  const want = CHAIN === 'arc' ? 20_000n : 50_000n;            // 0.02 USDC on Arc (40 payments; the rest of the wallet stays for gas and a later withdrawal), 0.05 on Base as in R5
  const size = (room < want ? room : want) - payBudget;        // keep a few payments' worth in the wallet as well
  const finalSize = size > 0n ? (size / 1000n) * 1000n : 0n;   // whole thousandths of a cent
  console.log(`gas: price ${Number(gasPrice) / 1e9} gwei, approve ${gApprove} gas, deposit ${gDeposit} gas; fee reserve (x1.5) ${CHAIN === 'arc' ? `${Number(feeUnits) / 1e6} USDC, paid from the same balance` : `${Number(feeWei) / 1e18} ETH, native, not USDC`}; wallet keeps ${Number(payBudget) / 1e6} USDC for payments`);
  if (finalSize < price * 2n) { console.log(`not enough USDC for a deposit that covers two payments after gas (room ${Number(finalSize) / 1e6}); nothing signed`); process.exit(4); }
  depositStr = (Number(finalSize) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  console.log(`deposit sized to ${depositStr} USDC: wallet ${Number(walletUnits) / 1e6} - deposit - gas reserve ${Number(feeUnits) / 1e6} leaves at least ${Number(walletUnits - finalSize - feeUnits) / 1e6} USDC`);
}
if (dry) { console.log(`dry run: would ${depositStr ? `deposit ${depositStr} USDC, then ` : ''}pay once; nothing signed`); process.exit(0); }
if (depositStr) { const d = await client.deposit(depositStr); console.log(`deposited ${d.formattedAmount ?? depositStr} USDC: tx ${d.depositTxHash ?? d.txHash ?? JSON.stringify(d).slice(0, 120)}`); }
const res = await client.pay(url);
console.log(`paid ${res.formattedAmount} USDC; status ok; transaction ${res.transaction ?? '-'}; data ${JSON.stringify(res.data).slice(0, 120)}`);
