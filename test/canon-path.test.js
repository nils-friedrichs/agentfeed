// R19: lib/canon-path.js, the one canonical-path function every "is this a priced path" decision uses. It reproduces the rules @x402/core 2.28 routes by
// (percent-decode each segment keeping %2F and %5C, collapse //, strip the trailing /, case-insensitive), so a spelling x402 would route to a priced
// route is a priced path everywhere else too.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonPath, pricedMatcher } = require('../lib/canon-path');
const PRICES = {
  'GET /api/time': { usd: 0.005, tool: 'get_time' },
  'GET /api/token-risk/:mint': { usd: 0.01, tool: 'get_token_risk' },
  'GET /api/keys/buy-5': { usd: 5, tool: 'buy_key_5' },
};

test('canonPath: the rules x402 routes by (case, //, trailing /, per-segment percent-decoding that keeps %2F and %5C, query and fragment dropped)', () => {
  const cases = [
    ['/api/time', '/api/time'], ['/API/TIME', '/api/time'], ['/Api/Time/', '/api/time'], ['/api/time//', '/api/time'], ['//api/time', '/api/time'], ['/api//time', '/api/time'],
    ['/api/%74ime', '/api/time'], ['/api/time?x=1#y', '/api/time'], ['/api/time;x=1', '/api/time;x=1'], ['/api/paper/10.1%2Fx', '/api/paper/10.1%2fx'],
    ['/api/paper/10.1%5Cx', '/api/paper/10.1%5cx'], ['/api/token-risk/AbC', '/api/token-risk/abc'], ['/api/%E0%A4%A', '/api/%e0%a4%a'], ['/', '/'], ['', ''],
  ];
  for (const [from, to] of cases) assert.equal(canonPath(from), to, JSON.stringify(from));
});

test('pricedMatcher: a pattern matches every spelling x402 would route to it, and nothing else', () => {
  const m = pricedMatcher(Object.keys(PRICES));
  for (const p of ['/api/time', '/API/TIME', '/api/time/', '/Api/time//', '/api/token-risk/ABC', '/API/TOKEN-RISK/abc/', '/api/%74ime', '/API/KEYS/BUY-5']) assert.ok(m.find(p), p);
  for (const p of ['/api/timex', '/api/time/x', '/api/token-risk', '/api/token-risk/a/b', '/x/api/time', '/api/sample', '/']) assert.equal(m.find(p), null, p);
  assert.equal(m.find('/API/TOKEN-RISK/abc').pattern, 'GET /api/token-risk/:mint');
});


test('pricedMatcher: a pattern is lower-cased like the path it is matched against (no live route has an upper-case literal today; a future one must still match)', () => {
  const m = pricedMatcher(['GET /api/Mixed-Case/:Id']);
  assert.ok(m.find('/api/mixed-case/x'));
  assert.ok(m.find('/API/MIXED-CASE/X/'));
  assert.equal(m.find('/api/mixed-case'), null);
});
