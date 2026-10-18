// R9 2b: GET /keys. The page must load nothing from anywhere, call nothing but this origin, and its CSP hashes must
// match the inline script and style it ships (a mismatch would leave a page whose Buy button silently does nothing).
// The browser flow itself (mock EIP-1193 wallet, real @x402/express, a facilitator stub verifying the EIP-712
// signature with viem) was run in the browser pane; see the R9 report.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { HTML, CSP, keysPage } = require('../tools/keys-page');

const hashOf = (s) => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";

test('keys page: the CSP allows exactly its inline script and style, same-origin fetches, nothing else', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1];
  assert.match(CSP, new RegExp(`script-src ${hashOf(script).replace(/[+/]/g, '\\$&')}(;|$)`));
  assert.match(CSP, new RegExp(`style-src ${hashOf(style).replace(/[+/]/g, '\\$&')}(;|$)`));
  assert.match(CSP, /default-src 'none'/);
  assert.match(CSP, /connect-src 'self'/);
  assert.equal((HTML.match(/<script/g) || []).length, 1, 'one inline script, no <script src>');
  assert.ok(!/<link[^>]+stylesheet/.test(HTML) && !/@import|url\(/.test(style), 'no external stylesheet or font');
  const urls = HTML.match(/https?:\/\/[^\s"'<]+/g) || [];
  assert.deepEqual([...new Set(urls.map((u) => new URL(u).host))].sort(), ['github.com', 'x402.ochinimus.app'], 'only a docs link and the curl example');
  assert.ok(!/fetch\(['"`]https?:/.test(script), 'every fetch is relative');
});

test('keys page: sends key_hash and never the key; signs EIP-3009 on Base only; shows the key after the 200', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
  assert.match(script, /key_hash='\+\(await sha256hex\(key\)\)/);
  assert.ok(!/[?&]key=/.test(script), 'no key in a URL');
  assert.match(script, /primaryType:'TransferWithAuthorization'/);
  assert.match(script, /a\.network===BASE&&a\.scheme==='exact'/);
  assert.match(script, /a\.extra\.name!=='GatewayWalletBatched'/);
  assert.ok(script.indexOf("$('key').textContent=key") > script.indexOf('if(r.status!==200)'), 'the key is shown only after a 200');
});

test('keys page: served with its CSP and no-referrer', () => {
  const h = {};
  let sent = null;
  const res = { set: (k, v) => { h[k] = v; }, type() { return this; }, send: (b) => { sent = b; } };
  keysPage({}, res);
  assert.equal(h['Content-Security-Policy'], CSP);
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.equal(sent, HTML);
});

// ---- R13 item 1 (15 Oct 2026): the page's script, run for real against a stub wallet and a stub server. A stranger buying the bot pass
// must see the pass's price, scope and term, get the key once with a header example that works for a pass (liq-feed, not signal-board),
// and the fine print must not say a pass has "no expiry".
const { _SCRIPT } = require('../tools/keys-page');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

async function runPage({ pack, price, data }) {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: '', style: {}, className: '', disabled: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  const accept = { scheme: 'exact', network: 'eip155:8453', amount: String(price * 1e6), asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };
  const seen = { urls: [], typed: null };
  const fetchStub = async (url, init = {}) => {
    seen.urls.push(url);
    const paid = init.headers && init.headers['PAYMENT-SIGNATURE'];
    if (!paid) return { status: 402, headers: { get: (k) => (k.toLowerCase() === 'payment-required' ? b64({ x402Version: 2, resource: { url: 'https://x402.ochinimus.app' + url.split('?')[0] }, accepts: [accept] }) : null) }, text: async () => '' };
    return { status: 200, headers: { get: () => null }, json: async () => ({ data }) };
  };
  const window = { ethereum: { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts') return ['0x' + 'ab'.repeat(20)];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_signTypedData_v4') { seen.typed = JSON.parse(params[1]); return '0x' + '11'.repeat(65); }
    throw new Error('unexpected wallet call ' + method);
  } } };
  const document = { getElementById: el, querySelector: () => ({ value: pack }) };
  new Function('document', 'window', 'crypto', 'fetch', 'navigator', _SCRIPT)(document, window, globalThis.crypto, fetchStub, {});
  await els.buy.listeners.click();
  return { els, seen };
}

test('keys page: the generated script parses', () => { new Function(_SCRIPT); });

test('keys page: buying the bot pass signs $25, shows the key once, and gives a header example that works for a pass', async () => {
  const data = { prefix: 'abcd1234', pass: { price_usd: 25, days: 30, routes: ['/api/liq-feed'], starts: 'when this payment settles', expires: '30 days after that' }, status: 'active', rate_per_min: 120 };
  const { els, seen } = await runPage({ pack: 'pass', price: 25, data });
  assert.equal(els.status.className, 'ok', els.status.textContent);
  assert.match(els.key.textContent, /^afk_[1-9A-HJ-NP-Za-km-z]{32,64}$/);
  assert.equal(els.result.style.display, 'block');
  assert.ok(seen.urls[0].startsWith('/api/keys/buy-pass?key_hash='));
  assert.equal(seen.typed.message.value, '25000000');
  assert.equal(seen.typed.message.to, '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6');
  assert.match(els.meta.textContent, /bot pass for \/api\/liq-feed only, valid until about 20\d\d-\d\d-\d\d \(30 days from this payment\), one call every 10 seconds, nothing drawn per call/);
  assert.match(els.examples.textContent, /^curl "https:\/\/x402\.ochinimus\.app\/api\/liq-feed\?symbols=BTCUSDT,ETHUSDT" -H "X-AgentFeed-Key: afk_\.\.\."\ncurl https:\/\/x402\.ochinimus\.app\/api\/keys\/balance .*expiry$/);
  assert.ok(!/signal-board/.test(els.examples.textContent), 'a pass key is refused on every other route (403)');
});

test('keys page: a pack still shows its balance and keeps the signal-board example', async () => {
  const { els } = await runPage({ pack: '5', price: 5, data: { prefix: 'abcd1234', balance_usd: 5, rate_per_min: 120, status: 'active' } });
  assert.equal(els.status.className, 'ok', els.status.textContent);
  assert.match(els.meta.textContent, /balance \$5, 120 requests a minute/);
  assert.equal(els.examples, undefined, 'the static example in the HTML is left alone');
});

test('keys page: the fine print states the pass term and does not say a pass has no expiry', () => {
  assert.match(HTML, /A prepaid balance is a usage credit: non-refundable, no expiry\. The bot pass is a flat price: non-refundable, valid 30 days from the payment, <code>\/api\/liq-feed<\/code> only, and it cannot be topped up/);
  assert.match(HTML, /a flat \$25 for 30 days of <code>\/api\/liq-feed<\/code> only, nothing drawn per call/);
  assert.match(HTML, /bot pass \$25: 30 days, \/api\/liq-feed only, no per-call charge/);
});

test('keys page: a Solana-only buyer is pointed at a docs section that exists', () => {
  const m = /docs\/nofx\.md#([a-z0-9-]+)/.exec(HTML);
  assert.ok(m, 'the page links a docs anchor');
  const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
  const heads = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'nofx.md'), 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, '')));
  assert.ok(heads.includes(m[1]), `docs/nofx.md has a heading for #${m[1]}`);
  assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'nofx.md'), 'utf8'), /spendControls: \{ maxAmountPerPayment: '\$25' \}/);
});

// ---- R15: the day pass in the page
test('keys page: buying the $1 day pass signs $1.00 to /api/keys/buy-day-pass and shows both routes and the 24 hours', async () => {
  const data = { prefix: 'abcd1234', pass: { price_usd: 1, days: 1, routes: ['/api/liq-feed', '/api/liquidations'], starts: 'when this payment settles', expires: '24 hours after that' }, status: 'active', rate_per_min: 120 };
  const { els, seen } = await runPage({ pack: 'day-pass', price: 1, data });
  assert.equal(els.status.className, 'ok', els.status.textContent);
  assert.ok(seen.urls[0].startsWith('/api/keys/buy-day-pass?key_hash='));
  assert.equal(seen.typed.message.value, '1000000');
  assert.match(els.meta.textContent, /^prefix abcd1234, day pass for \/api\/liq-feed, \/api\/liquidations only, valid until about 20\d\d-\d\d-\d\d \d\d:\d\d UTC \(24 hours from this payment\), \/api\/liq-feed answers one call every 10 seconds, nothing drawn per call$/);
  assert.match(els.examples.textContent, /^curl "https:\/\/x402\.ochinimus\.app\/api\/liq-feed\?symbols=BTCUSDT,ETHUSDT" -H "X-AgentFeed-Key: afk_\.\.\."\ncurl "https:\/\/x402\.ochinimus\.app\/api\/liquidations\?symbol=SOLUSDT" -H "X-AgentFeed-Key: afk_\.\.\."\ncurl https:\/\/x402\.ochinimus\.app\/api\/keys\/balance /);
});

test('keys page: the day pass is offered with its price, term and routes, and the fine print says so', () => {
  assert.match(HTML, /day pass \$1: 24 hours, \/api\/liq-feed and \/api\/liquidations, no per-call charge/);
  assert.match(HTML, /The day pass is the same for 24 hours on <code>\/api\/liq-feed<\/code> and <code>\/api\/liquidations<\/code>\./);
  assert.match(HTML, /The day pass: a flat \$1 for 24 hours of <code>\/api\/liq-feed<\/code> and <code>\/api\/liquidations<\/code>/);
});
