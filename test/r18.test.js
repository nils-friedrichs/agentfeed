// R18 (19 Oct 2026): the stale "28-day tape of 1.4M Bybit liquidations across 799 symbols" claim (an August snapshot; caliper refits every 6 hours on
// the rolling multi-venue tape) must not come back on any user-facing surface of this repo. R17 replaced it in the price table and the README row;
// this pins it. The README row must read exactly like the price table (box only: the price table opens the box databases on require).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STALE = /1\.4M\b|1\.4 million|\b799 symbols\b|\b799\b.{0,12}\bsymbols?\b/i;

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
});

const HAVE_BOX = fs.existsSync('/opt/agentfeed/liquidations.db') && fs.existsSync('/opt/overhang/overhang.db');
test('R18: the README get_cascade_forecast row carries the price-table description, word for word', { skip: HAVE_BOX ? false : 'needs the box databases' }, () => {
  const { PRICES } = require('../payments');
  const desc = PRICES['GET /api/cascade-forecast'].desc;
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const rows = readme.split('\n').filter((l) => l.startsWith('| `get_cascade_forecast` |') && l.includes('`/api/cascade-forecast`') && l.length > 400);
  assert.equal(rows.length, 1, 'one full catalogue row');
  assert.ok(rows[0].includes(desc), 'the row reads like the price table');
  assert.match(desc, /Calibrated on a 28-day tape of our own multi-venue liquidation record/);
});
