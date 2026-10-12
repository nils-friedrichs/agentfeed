// ops/pay-arc.mjs <url> <path-to-evm-key-file> — one paid call on the Arc rail only (R4).
//
// test-client-evm.mjs registers eip155:* and so pays the first EVM accept, which is Base.
// This one registers eip155:5042 alone, so the Arc accept (USDC 0x3600..., settled by
// Circle's Facilitator Service) is the only one it can sign. The key file holds one 0x
// private key; it is read, never printed. Prints the status, the payer, and the settlement.
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

const [url, keyPath] = process.argv.slice(2);
if (!url || !keyPath) { console.error('usage: node ops/pay-arc.mjs <url> <evm-key-file>'); process.exit(2); }
const account = privateKeyToAccount(fs.readFileSync(keyPath, 'utf8').trim());
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:5042', client: new ExactEvmScheme(account) }] });
const res = await pay(url);
console.log('payer', account.address, 'status', res.status);
const pr = res.headers.get('payment-required');
if (pr) console.log('refused:', decodePaymentRequiredHeader(pr).error);
const settle = res.headers.get('payment-response');
if (settle) { const s = decodePaymentResponseHeader(settle); console.log('settled', s.success, 'network', s.network, 'tx', s.transaction); }
console.log((await res.text()).slice(0, 300));
