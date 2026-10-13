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
