// ops/r10-unfunded-evm.mjs <base url> <network...> — R10 G5: one verify-only probe per network, never billed.
//
// The real v2 client (@x402/fetch + @x402/evm exact, as test-client-evm.mjs) signs a correct EIP-3009 authorization from a FRESH
// key that holds nothing, for exactly the named network (the client registers that network only, so it can pick no other
// accept). The service hands it to that network's facilitator, which must refuse it: the payer has no funds. The reason tells
// the EIP-712 domain apart: insufficient_funds (or a balance error) means the signature verified against the token's domain,
// invalid_signature means our name/version is wrong. Nothing can settle: there is nothing to move.
//
// It asks with /api/perp|<network>, so an on-request network is in the 402. Run it against a scratch boot or the live service.
// ALLOW_ANY_ASSET=1 sets spendControls.allowedAssets: true. Without it @x402/fetch 2.28 refuses every token that is not in
// @x402/evm DEFAULT_ASSETS (Optimism, HyperEVM, Unichain, Scroll, SKALE Base, BNB, Robinhood, World, X Layer on 2026-10-14):
// a stock client must add an allowedAssets entry to pay those.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';

const [base, ...nets] = process.argv.slice(2);
if (!base || !nets.length) { console.error('usage: node ops/r10-unfunded-evm.mjs <base url> <eip155:N> [...]'); process.exit(2); }
for (const net of nets) {
  const account = privateKeyToAccount(generatePrivateKey());
  let sent = null;
  const spy = (input, init) => { const h = input instanceof Request ? input.headers : init && init.headers; if (h) sent = h; return fetch(input, init); };
  const pay = wrapFetchWithPaymentFromConfig(spy, { schemes: [{ network: net, client: new ExactEvmScheme(account) }], ...(process.env.ALLOW_ANY_ASSET === '1' ? { spendControls: { allowedAssets: true } } : {}) });
  const res = await pay(`${base}/api/perp|${net}`).catch((e) => ({ status: 'client threw', e }));
  const h = sent ? Object.fromEntries((sent instanceof Headers ? [...sent] : Object.entries(sent)).map(([k, v]) => [k.toLowerCase(), v])) : {};
  const sig = h['payment-signature'];
  const chosen = sig ? JSON.parse(Buffer.from(sig, 'base64')).accepted : null;
  let reason = '';
  if (res.headers) { const pr = res.headers.get('payment-required'); reason = pr ? String(decodePaymentRequiredHeader(pr).error || '').slice(0, 200) : '(no PAYMENT-REQUIRED)'; }
  console.log(JSON.stringify({ network: net, payer: account.address, signed_for: chosen ? `${chosen.network} ${chosen.asset} ${chosen.extra && chosen.extra.name}/${chosen.extra && chosen.extra.version}` : null, status: res.status, reason: reason || (res.e ? res.e.message.slice(0, 200) : '') }));
}
