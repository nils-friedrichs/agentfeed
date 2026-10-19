// R18/R18b (19 Oct 2026): the stale "28-day tape of 1.4M Bybit liquidations across 799 symbols" claim (an August snapshot) must not come back on any
// user-facing surface of this repo. R17 first replaced it with "a 28-day tape of our own multi-venue liquidation record", which was false on "28-day"
// too: caliper/bin/fit.mjs trains on the WHOLE tape and cron refits it every 6 hours. R18b says that. This pins both. The README row must read exactly
// like the price table (box only: the price table opens the box databases on require).
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

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
test('R18: the README get_cascade_forecast row carries the price-table description, word for word', { skip: HAVE_BOX ? false : 'needs the box databases' }, () => {
  const { PRICES } = require('../payments');
  const desc = PRICES['GET /api/cascade-forecast'].desc;
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const rows = readme.split('\n').filter((l) => l.startsWith('| `get_cascade_forecast` |') && l.includes('`/api/cascade-forecast`') && l.length > 400);
  assert.equal(rows.length, 1, 'one full catalogue row');
  assert.ok(rows[0].includes(desc), 'the row reads like the price table');
  const SENTENCE = 'Calibrated on our whole multi-venue liquidation tape, more than 6 million liquidations recorded since 8 July 2026 and refit every 6 hours, which cannot be reconstructed';
  assert.ok(desc.includes(SENTENCE), 'the price table carries the R18b sentence');
  assert.ok(rows[0].includes(SENTENCE), 'and so does the README row');
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
