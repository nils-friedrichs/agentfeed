// ops/arc-sweep.mjs <cold-address> [--send] — move the Arc payTo's USDC to cold storage (R4).
//
// On Arc, USDC is the gas token and one balance: the native balance (18 decimals) equals the
// ERC-20 balance at 0x3600... (6 decimals) times 1e12. So a plain native send of the balance
// minus its own gas empties the address. Dry run by default: prints balance, gas and the
// amount that would move. --send signs and broadcasts with the key at ARC_PAYTO_KEY
// (default /root/.config/agentfeed/arc-payto.key); the key is read, never printed.
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, isAddress, formatUnits, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const [to, flag] = process.argv.slice(2);
if (!to || !isAddress(to)) { console.error('usage: node ops/arc-sweep.mjs <cold-address> [--send]'); process.exit(2); }
const arc = defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const account = privateKeyToAccount(fs.readFileSync(process.env.ARC_PAYTO_KEY || '/root/.config/agentfeed/arc-payto.key', 'utf8').trim());
const pub = createPublicClient({ chain: arc, transport: http() });
if ((await pub.getChainId()) !== 5042) throw new Error('RPC is not Arc mainnet');
const balance = await pub.getBalance({ address: account.address });
const fees = await pub.estimateFeesPerGas();
const gas = 21000n;
const cost = gas * fees.maxFeePerGas * 2n; // headroom; unused fee stays behind as dust
const value = balance > cost ? balance - cost : 0n;
console.log(`from ${account.address} to ${to}`);
console.log(`balance ${formatUnits(balance, 18)} USDC, gas reserve ${formatUnits(cost, 18)}, would send ${formatUnits(value, 18)}`);
if (flag !== '--send') { console.log('dry run: add --send to broadcast'); process.exit(0); }
if (value === 0n) { console.log('nothing to send'); process.exit(0); }
const wallet = createWalletClient({ account, chain: arc, transport: http() });
const hash = await wallet.sendTransaction({ to, value, gas, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n });
console.log('sent', hash, `https://explorer.arc.io/tx/${hash}`);
const r = await pub.waitForTransactionReceipt({ hash });
console.log('status', r.status, 'block', r.blockNumber);
