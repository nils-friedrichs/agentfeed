// mpp/tempo-check.mjs <base> — tempo challenge on every paid route (mppx client parser),
// header sizes, push refused, cross-route replay refused, real mppx client (fresh unfunded key).
import { Challenge, Credential } from 'mppx';
import { Mppx, tempo } from 'mppx/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const B = process.argv[2] || 'http://localhost:3997';
const spec = await fetch(B + '/openapi.json').then((r) => r.json());
const urls = Object.keys(spec.paths).filter((p) => spec.paths[p].get && spec.paths[p].get['x-payment-info'])
  .map((p) => p.replace('{wallet}', 'Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu').replace('{mint}', 'So11111111111111111111111111111111111111112'));
let bad = 0, maxPR = [0, ''], maxWA = [0, ''], maxBlock = [0, ''];
const want = { OUSD: '0x20c0000000000000000000006a37da5c996874be', 'USDC.e': '0x20c000000000000000000000b9537d11c60e8b50' };
for (const u of urls) {
  const r = await fetch(B + u);
  const wa = r.headers.get('www-authenticate') || '';
  let list = [];
  try { list = Challenge.fromHeadersList(r.headers); } catch (e) { bad++; console.log('PARSE FAIL', u, e.message.slice(0, 80)); continue; }
  const t = list.filter((c) => c.method === 'tempo' && c.intent === 'charge');
  const ok = r.status === 402 && r.headers.get('payment-required') && t.length === 2
    && t.map((c) => String(c.request.currency).toLowerCase()).join() === `${want.OUSD},${want['USDC.e']}`
    && t.every((c) => c.request.recipient.toLowerCase() === '0x22db3a9686ee5261e7bf3ed4f91277232e8076e6' && c.request.methodDetails && c.request.methodDetails.chainId === 4217 && JSON.stringify(c.request.supportedModes || (c.request.methodDetails && c.request.methodDetails.supportedModes)).includes('pull') && !c.request.methodDetails.feePayer);
  if (!ok) { bad++; console.log('BAD', u, r.status, t.length, JSON.stringify(t[0] && t[0].request).slice(0, 200)); }
  const pr = (r.headers.get('payment-required') || '').length;
  let block = 0; for (const [k, v] of r.headers) block += k.length + v.length + 4;
  if (pr > maxPR[0]) maxPR = [pr, u]; if (wa.length > maxWA[0]) maxWA = [wa.length, u]; if (block > maxBlock[0]) maxBlock = [block, u];
  if (/sol-price|btc-price/.test(u) && !list.some((c) => c.method === 'solana')) { bad++; console.log('NO SOLANA', u); }
}
console.log(`tempo on ${urls.length - bad}/${urls.length} routes | max PAYMENT-REQUIRED ${maxPR[0]} B (${maxPR[1]}) | max WWW-Authenticate ${maxWA[0]} B (${maxWA[1]}) | max header block ${maxBlock[0]} B (${maxBlock[1]})`);
const sample = await fetch(B + '/api/price');
const ch = Challenge.fromHeadersList(sample.headers).find((c) => c.method === 'tempo');
console.log('amount on /api/price:', ch.request.amount, '| currency', ch.request.currency.slice(0, 12), '| expires', ch.expires);
const send = async (path, cred) => { const r = await fetch(B + path, { headers: { authorization: Credential.serialize(cred) } }); const j = await r.json().catch(() => ({})); return `${r.status} ${String(j.type || '').split('/').pop()}: ${String(j.detail || '').slice(0, 150)}`; };
console.log('push (hash) credential  ->', await send('/api/price', { challenge: ch, payload: { type: 'hash', hash: '0x' + '11'.repeat(32) }, source: 'did:pkh:eip155:4217:0x000000000000000000000000000000000000dEaD' }));
console.log('cheap challenge, $0.10 route ->', await send('/api/squeeze-score', { challenge: ch, payload: { type: 'transaction', signature: '0x76' + 'ab'.repeat(120) } }));
console.log('garbage tx, same route  ->', await send('/api/price', { challenge: ch, payload: { type: 'transaction', signature: '0x76' + 'ab'.repeat(120) } }));
try {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = Mppx.create({ methods: [tempo.charge({ account, mode: 'pull' })], polyfill: false });
  const r = await client.fetch(B + '/api/price');
  const j = await r.json().catch(() => ({}));
  console.log('real mppx client, fresh key ->', r.status, String(j.type || '').split('/').pop(), String(j.detail || JSON.stringify(j)).slice(0, 180));
} catch (e) { console.log('real mppx client, fresh key -> client threw before sending:', String(e.message).slice(0, 200)); }
