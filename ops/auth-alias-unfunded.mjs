// x402 v2 payment (fresh never-funded Solana key) sent in Authorization: Payment <base64>
import { generateKeyPairSigner } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
for (const url of process.argv.slice(2)) {
  const first = await fetch(url);
  const pr = decodePaymentRequiredHeader(first.headers.get('payment-required'));
  const client = new x402Client().register('solana:*', new ExactSvmScheme(toClientSvmSigner(await generateKeyPairSigner())));
  const p = await client.createPaymentPayload({ ...pr, accepts: pr.accepts.filter((a) => a.network.startsWith('solana')) });
  const r = await fetch(url, { headers: { Authorization: `Payment ${encodePaymentSignatureHeader(p)}` } });
  const h = r.headers.get('payment-required');
  console.log(url.replace(/^https:\/\/[^/]+/, '').padEnd(18), r.status, '|', h ? decodePaymentRequiredHeader(h).error.slice(0, 150) : (await r.text()).slice(0, 150));
}
