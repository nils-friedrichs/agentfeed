// ops/r10-proof-evm.mjs <network> <key file> [route] — R10 proof payment on ONE EVM network (his step; run on the VPS).
// DRY RUN by default: prints the accept it would sign (network, token, amount, payTo, EIP-712 name/version) and stops.
// PAY=1 signs and sends it. The client registers that network only, so it cannot pay any other accept, and allowedAssets
// names exactly the accept's token (@x402/fetch 2.28 otherwise refuses tokens outside @x402/evm DEFAULT_ASSETS).
// Default route /api/sol-price ($0.001); Sei and X Layer need a route priced $0.005 or more (default /api/perp for them).
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';

const [net, keyPath, routeArg] = process.argv.slice(2);
if (!net || !keyPath) { console.error('usage: [PAY=1] node ops/r10-proof-evm.mjs <eip155:N> <key file> [route]'); process.exit(2); }
const route = routeArg || (['eip155:1329', 'eip155:196'].includes(net) ? '/api/perp' : '/api/sol-price');
const url = `https://x402.ochinimus.app${route}|${net}`;
const account = privateKeyToAccount(fs.readFileSync(keyPath, 'utf8').trim());
const pr = await fetch(url);
const c = JSON.parse(Buffer.from(pr.headers.get('payment-required'), 'base64').toString('utf8'));
const a = c.accepts.find((x) => x.network === net && x.scheme === 'exact');
if (!a) { console.log(`no exact accept for ${net} on ${route}`); process.exit(1); }
console.log(`payer ${account.address}\nwould pay ${a.amount} base units of ${a.asset} on ${net} to ${a.payTo} (EIP-712 ${a.extra.name}/${a.extra.version}) for ${route}`);
if (process.env.PAY !== '1') { console.log('DRY RUN: nothing signed. Re-run with PAY=1 to pay.'); process.exit(0); }
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: net, client: new ExactEvmScheme(account) }],
  spendControls: { allowedAssets: true, maxAmountPerPayment: 0.05 },
});
const res = await pay(url);
console.log('status:', res.status);
const s = res.headers.get('payment-response');
if (s) console.log('settlement:', JSON.stringify(decodePaymentResponseHeader(s)));
else console.log('no settlement header; reason:', res.headers.get('payment-required') ? JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64')).error : (await res.text()).slice(0, 200));
