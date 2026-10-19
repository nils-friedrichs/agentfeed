// R18/R18b/R18c (19 Oct 2026): the stale "28-day tape of 1.4M Bybit liquidations across 799 symbols" claim (an August snapshot) must not come back on any
// user-facing surface of this repo. R17 first replaced it with "a 28-day tape of our own multi-venue liquidation record", which was false on "28-day"
// too: caliper/bin/fit.mjs trains on the WHOLE tape and cron refits it every 6 hours. R18b says that. This pins both. The README row must read exactly
// like the price table (box only: the price table opens the box databases on require). R18c: the sentence is shortened so that the first three sentences of the
// forecast description still fit firstSentences(desc, 400), the builder of the /.well-known/x402 catalogue (R18b's longer sentence made that entry drop it), and the
// MCP descriptions (tools/list) are held to the same rules as the files: no stale figures anywhere, no venue names on the four cascade/heatmap tools.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STALE = /1\.4M\b|1\.4 million|\b799 symbols\b|\b799\b.{0,12}\bsymbols?\b|28-day tape/i;   // R18b: the model is fitted on the WHOLE tape (caliper bin/fit.mjs), there is no 28-day window

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'test', 'mpp'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(js|mjs|json|md|txt|html|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('R18: no user-facing file of the repo (README, docs, lib, tools, root scripts, server.json, the stored examples) carries the stale tape figures', () => {
  const files = walk(ROOT);
  assert.ok(files.some((f) => f.endsWith('README.md')) && files.some((f) => f.endsWith('bazaar-examples.json')) && files.some((f) => f.endsWith(path.join('docs', 'SOURCES.md'))), 'control: the walk reaches the README, the examples and docs/');
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => { if (STALE.test(l)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`); });
  }
  assert.deepEqual(hits, [], 'stale figures still present');
  assert.ok(STALE.test('Calibrated on a 28-day tape of 1.4M Bybit liquidations across 799 symbols'), 'control: the pattern matches the claim it guards against');
  assert.ok(STALE.test('Calibrated on a 28-day tape of our own multi-venue liquidation record'), 'control: and the R17 wording that was false on 28-day');
});

// R18c: exactly this sentence, 182 characters; the first two sentences of the description are 213, so all three fit the 400 of firstSentences().
const SENTENCE = 'Calibrated on our whole multi-venue liquidation tape, over 6 million liquidations since 8 July 2026, refit every 6 hours; no exchange publishes that history, so it cannot be rebuilt.';
const R18B_SENTENCE = 'Calibrated on our whole multi-venue liquidation tape, more than 6 million liquidations recorded since 8 July 2026 and refit every 6 hours, which cannot be reconstructed by anyone starting today because no exchange publishes liquidation history.';
const VENUES = /Bybit|OKX|Binance|Deribit/i;
const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
test('R18: the README get_cascade_forecast row carries the price-table description, word for word', { skip: HAVE_BOX ? false : 'needs the box databases' }, () => {
  const { PRICES } = require('../payments');
  const desc = PRICES['GET /api/cascade-forecast'].desc;
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const rows = readme.split('\n').filter((l) => l.startsWith('| `get_cascade_forecast` |') && l.includes('`/api/cascade-forecast`') && l.length > 400);
  assert.equal(rows.length, 1, 'one full catalogue row');
  assert.ok(rows[0].includes(desc), 'the row reads like the price table');
  assert.ok(desc.includes(SENTENCE), 'the price table carries the R18c sentence');
  assert.ok(rows[0].includes(SENTENCE), 'and so does the README row');
  assert.ok(!desc.includes(R18B_SENTENCE) && !rows[0].includes(R18B_SENTENCE), 'the longer R18b sentence is gone from both');
  assert.ok(!/bybit|okx|binance/i.test(desc), 'no venue names (C7)');
});

test('R18b: the sentence is true on the box: the tape holds more than 6 million liquidations and starts on 8 July 2026', { skip: HAVE_BOX ? false : 'needs the box databases' }, () => {
  const Database = require('better-sqlite3');
  const db = new Database('/opt/agentfeed/liquidations.db', { readonly: true, fileMustExist: true });
  const r = db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS lo FROM liquidations').get();
  db.close();
  assert.ok(r.n > 6_000_000, `${r.n} rows`);
  assert.equal(new Date(r.lo).toISOString().slice(0, 10), '2026-07-08', 'recorded since 8 July 2026');
});

test('R18c: the sentence is 182 characters and the first three sentences of the forecast description fit 400 (a control, on any machine)', () => {
  assert.equal(SENTENCE.length, 182);
  const first = 'Liquidation forecast, FORWARD-LOOKING and not a description of what already happened. Returns the probability that a symbol will liquidate more in the NEXT 15 minutes than its own 90th-percentile 15-minute window.';
  assert.equal(first.length, 213, 'the first two sentences');
  assert.ok(first.length + 1 + SENTENCE.length <= 400, 'R18c fits');
  assert.ok(first.length + 1 + R18B_SENTENCE.length > 400, 'control: the R18b sentence did not fit, which is why /.well-known/x402 dropped it');
});

test('R18c: /.well-known/x402 (firstSentences at 400) keeps the forecast sentence: its catalogue entry contains "refit every 6 hours"; the R18b sentence is the control that loses it', { skip: HAVE_BOX ? false : 'needs the box databases' }, () => {
  const { PRICES, BAZAAR_META } = require('../payments');
  const D = require('../tools/discovery');
  const key = 'GET /api/cascade-forecast';
  const entry = D.buildWellKnown({ PRICES, META: BAZAAR_META }).resourceCatalog.find((r) => /\/api\/cascade-forecast$/.test(r.url));
  assert.ok(entry, 'the forecast has a catalogue entry');
  assert.ok(entry.description.includes('refit every 6 hours'), entry.description);
  assert.ok(entry.description.includes(SENTENCE), 'the whole sentence');
  assert.ok(entry.description.length <= 400, `${entry.description.length} characters`);
  // control: the same builder on the R18b wording drops the sentence, so the assertion above can fail
  const old = { ...PRICES, [key]: { ...PRICES[key], desc: PRICES[key].desc.replace(SENTENCE, R18B_SENTENCE) } };
  assert.notEqual(old[key].desc, PRICES[key].desc, 'control: the swap changed the text');
  const oldEntry = D.buildWellKnown({ PRICES: old, META: BAZAAR_META }).resourceCatalog.find((r) => /\/api\/cascade-forecast$/.test(r.url));
  assert.ok(!oldEntry.description.includes('refit every 6 hours'), 'control: with the R18b sentence the entry loses it');
});

test('R18c: the MCP descriptions (tools/list) carry no stale figure, the four cascade/heatmap tools carry no venue name, cascade_scan reads like the price table, the forecast carries the sentence', { skip: HAVE_BOX ? false : 'needs the box databases' }, () => {
  const { TOOL_DEFS } = require('../mcp');
  const { PRICES } = require('../payments');
  const text = (d) => `${d.desc}${d.docNote ? ` ${d.docNote}` : ''}`;   // what mcp.js hands tools/list, before its fixed " Costs N USDC per call (...)." suffix
  assert.ok(TOOL_DEFS.length >= 85 && ['get_cascade_scan', 'get_cascade_alert', 'get_cascade_forecast', 'get_liq_heatmap'].every((n) => TOOL_DEFS.some((d) => d.name === n)), 'control: the table is the real one');
  const stale = TOOL_DEFS.filter((d) => STALE.test(text(d))).map((d) => d.name);
  assert.deepEqual(stale, [], 'stale figures in an MCP description');
  for (const n of ['get_cascade_alert', 'get_cascade_scan', 'get_cascade_forecast', 'get_liq_heatmap']) assert.ok(!VENUES.test(text(TOOL_DEFS.find((d) => d.name === n))), `${n}: no venue name in its MCP text`);
  const scan = TOOL_DEFS.find((d) => d.name === 'get_cascade_scan');
  assert.equal(text(scan), PRICES['GET /api/cascade-scan'].desc, 'cascade_scan: the MCP text is the price-table (OpenAPI) text');
  assert.ok(text(TOOL_DEFS.find((d) => d.name === 'get_cascade_forecast')).includes(SENTENCE), 'forecast: the MCP text carries the R18c sentence');
  // controls: the guards fire on the texts they exist for (the 5936d81 cascade_scan text and the R17 forecast text)
  assert.ok(VENUES.test('FULL-UNIVERSE cascade scan: detects liquidation cascades across every USDT perp we record on Bybit, OKX and Binance simultaneously'), 'control: the venue check matches the old cascade_scan text');
  assert.ok(STALE.test('Calibrated on a 28-day tape of our own multi-venue liquidation record'), 'control: the stale check matches the R17 forecast text');
});
