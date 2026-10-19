// R15 (19 Oct 2026): the 24-hour day pass wired in. The key mechanism itself is test/keys-daypass.test.js; this file pins the WIRING that
// needs the box's data files (expansion.js opens the liquidation, peg and overhang databases on require), so, like r9-wiring.test.js and
// r11-wiring.test.js, the tests skip with a reason on a machine without them: the price table row, the exact-only accepts, the one line in
// the liq-feed 402 description, the text surfaces, and that the pass is an HTTP route and not an MCP tool.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
const skip = HAVE_BOX ? false : 'needs the box databases (/opt/agentfeed/liquidations.db, /opt/overhang/overhang.db)';
const ROUTE = 'GET /api/keys/buy-day-pass';

test('price table: the day pass is $1.00, an exact-only key route, with its own tags, question and 24-hour description', { skip }, () => {
  const { PRICES, TAGS } = require('../payments');
  const { QUESTIONS } = require('../tools/questions');
  const p = PRICES[ROUTE];
  assert.ok(p);
  assert.deepEqual([p.usd, p.tool, p.noHf], [1, 'buy_key_day_pass', true]);
  assert.ok(TAGS.buy_key_day_pass.includes('pass') && TAGS.buy_key_day_pass.includes('liquidations'));
  assert.match(QUESTIONS.buy_key_day_pass, /24 hours/);
  assert.match(p.desc, /^Day pass: \$1 flat for 24 hours of unlimited calls to \/api\/liq-feed and \/api\/liquidations /);
  assert.match(p.desc, /It starts when the payment settles and ends 24 hours later/);
  assert.match(p.desc, /Non-refundable, cannot be topped up/);
  assert.match(p.desc, /each of the two routes answers one call every 10 seconds per key \(6 a minute\)/, 'R15c: the route description (openapi, catalogue) states the cadence');
});

test('accepts: the day pass carries the exact accepts only, every one for exactly 1,000,000 atomic units', { skip }, () => {
  const { PRICES, routeAccepts } = require('../payments');
  const { hfAccepts } = require('../lib/hf');
  const rails = require('../lib/rails');
  const HF = { batch: { networks: ['eip155:8453'], receiver: '0x' + '22'.repeat(20) }, gateway: { networks: ['eip155:5042'], payTo: '0x' + 'a8'.repeat(20) } };
  const EVM = [{ network: 'eip155:8453', name: 'Base' }, { network: 'eip155:5042', name: 'Arc', asset: { address: '0x3600000000000000000000000000000000000000', decimals: 6, extra: { name: 'USDC', version: '2' } } }];
  const acc = routeAccepts(PRICES[ROUTE], { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', payTo: 'TREASURYsol', EVM, ALGO: { network: 'algorand:mainnet', payTo: 'ALGOPAYTO' }, HF,
    railPrice: rails.railPrice, railPayTo: () => '0x' + '22'.repeat(20), hfAccepts });
  assert.ok(acc.every((a) => a.scheme === 'exact' && !(a.extra && a.extra.name === 'GatewayWalletBatched')), 'exact only: credit-like passes get no half-price accept');
  for (const a of acc) {
    const atomic = typeof a.price === 'string' ? Math.round(Number(a.price.slice(1)) * 1e6) : Number(a.price.amount);
    assert.equal(atomic, 1_000_000, `${a.network}: $1.00`);
  }
});

test('the liq-feed 402 description carries one line about the day pass, inside the 400-character cap, with its question; no other route says it', { skip }, () => {
  const { PRICES, challengeLead, challengeDesc, CHALLENGE_DESC_MAX } = require('../payments');
  const line = 'Heavy pollers can buy a $1 day pass (GET /api/keys/buy-day-pass).';
  const d = challengeDesc(challengeLead(PRICES['GET /api/liq-feed']));
  assert.ok(d.endsWith(line), d.slice(-120));
  assert.ok(d.length <= CHALLENGE_DESC_MAX, `${d.length} chars`);
  assert.match(d, /Use when you need to answer: /);
  assert.ok(PRICES['GET /api/liq-feed'].desc.length >= 180 && PRICES['GET /api/liq-feed'].desc.length <= 255, 'the catalogue description is untouched and inside its band');
  assert.ok(!PRICES['GET /api/liq-feed'].desc.includes('day pass'));
  for (const [route, p] of Object.entries(PRICES)) {
    if (route === 'GET /api/liq-feed') continue;
    assert.ok(!challengeDesc(challengeLead(p)).includes('Heavy pollers can buy'), `${route} does not carry the line`);
  }
});

test('text surfaces: openapi documents the route and its key_hash parameter; llms.txt and SKILL.md carry the day-pass sentence', { skip }, () => {
  const { PRICES, TAGS, BAZAAR_META } = require('../payments');
  const D = require('../tools/discovery');
  const ctx = { PRICES, TAGS, META: BAZAAR_META, FREE_TOOLS: ['get_fear_greed'], mpp: { active: false, routes: [] }, tempo: { active: false }, network: 'mainnet' };
  const api = D.buildOpenApi(ctx);
  assert.ok(api.paths['/api/keys/buy-day-pass'], 'openapi has the route');
  assert.ok((api.paths['/api/keys/buy-day-pass'].get.parameters || []).some((p) => p.name === 'key_hash'));
  const sentence = 'A 24-hour day pass for /api/liq-feed and /api/liquidations is $1 flat (/api/keys/buy-day-pass), each route one call every 10 seconds per key (6 a minute)';   // R15c
  for (const [name, text] of [['openapi', JSON.stringify(api)], ['llms.txt', D.buildLlmsTxt(ctx)], ['SKILL.md', D.buildSkillMd(ctx)]]) assert.ok(text.includes(sentence), `${name} carries the sentence`);
});

test('the day pass is a REST route only, and its Bazaar example is a constructed one with a placeholder key', { skip }, () => {
  const { TOOL_DEFS } = require('../mcp');
  assert.ok(!TOOL_DEFS.some((d) => d.name === 'buy_key_day_pass'), 'not an MCP tool');
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bazaar-examples.json'), 'utf8')).routes[ROUTE];
  assert.equal(meta.static, true);
  assert.equal(meta.price_usd, 1);
  const ex = meta.output.example.data;
  assert.match(ex.key, /^afk_x+$/);
  assert.deepEqual(ex.pass.routes, ['/api/liq-feed', '/api/liquidations']);
  assert.equal(ex.pass.expires, '24 hours after that');
  assert.match(ex.use, /; each route answers one call every 10 seconds per key \(6 a minute\)$/, 'R15c: the example purchase body states the cadence');
});
