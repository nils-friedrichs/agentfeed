'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { keyLowAlert } = require('../ops/af-digest');
const { SCHEMA } = require('../lib/keys');

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
function fresh({ keysTable = true } = {}) {
  const db = new Database(':memory:');
  if (keysTable) db.exec(SCHEMA);
  return {
    db,
    key: (p, st, bal, label) => db.prepare('INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, created, label) VALUES (?, ?, ?, ?, 0, 1, ?)').run('h' + p, p, st, bal, label),
    setBal: (p, bal) => db.prepare('UPDATE api_keys SET balance_micro = ? WHERE prefix = ?').run(bal, p),
  };
}
const sink = () => { const sent = [], logs = []; return { sent, logs, io: { send: async (t) => { sent.push(t); return true; }, log: (l) => logs.push(l) } }; };

test('alerts on active apify keys under $5 only, one message naming each', async () => {
  const { db, key } = fresh();
  key('7MvAdiJM', 'active', 49540000, 'apify-actors');
  key('Fss3nxHt', 'active', 4999999, 'apify-scholarly-paper-search');
  key('5j7JgE6w', 'active', 0, 'apify-sec-edgar-filings');
  key('AkWvjStq', 'revoked', 0, 'apify-pdf-to-markdown');
  key('0thrKey1', 'active', 100, 'tradingagents-dev');
  const { sent, io } = sink();
  assert.equal(await keyLowAlert(db, {}, NOW, io), 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /2 Apify comp keys are under \$5\.000/);
  assert.match(sent[0], /apify-sec-edgar-filings \(5j7JgE6w\): \$0\.000 left/);
  assert.match(sent[0], /apify-scholarly-paper-search \(Fss3nxHt\): \$5\.000 left/);
  assert.doesNotMatch(sent[0], /7MvAdiJM|AkWvjStq|0thrKey1/);
});

test('exactly $5 is not low, and four healthy keys send nothing', async () => {
  const { db, key } = fresh();
  key('7MvAdiJM', 'active', 5000000, 'apify-actors');
  key('Fss3nxHt', 'active', 19850000, 'apify-scholarly-paper-search');
  const { sent, io } = sink();
  assert.equal(await keyLowAlert(db, {}, NOW, io), 0);
  assert.equal(sent.length, 0);
});

test('quiet for six hours, then again; a recovered key is forgotten and alerts at once on its next drop', async () => {
  const { db, key, setBal } = fresh();
  key('Fss3nxHt', 'active', 1000000, 'apify-scholarly-paper-search');
  const state = {}, { sent, io } = sink();
  assert.equal(await keyLowAlert(db, state, NOW, io), 1);
  assert.equal(await keyLowAlert(db, state, NOW + 5 * 3600e3, io), 0);
  assert.equal(sent.length, 1);
  assert.equal(await keyLowAlert(db, state, NOW + 6 * 3600e3, io), 1);
  assert.equal(sent.length, 2);
  setBal('Fss3nxHt', 20000000);
  assert.equal(await keyLowAlert(db, state, NOW + 7 * 3600e3, io), 0);
  assert.deepEqual(state.keyLow, {});
  setBal('Fss3nxHt', 2000000);
  assert.equal(await keyLowAlert(db, state, NOW + 7 * 3600e3 + 60e3, io), 1);
  assert.equal(sent.length, 3);
});

test('a second key dropping inside the first key\'s quiet hours is alerted alone', async () => {
  const { db, key, setBal } = fresh();
  key('Fss3nxHt', 'active', 1000000, 'apify-scholarly-paper-search');
  key('5j7JgE6w', 'active', 19925000, 'apify-sec-edgar-filings');
  const state = {}, { sent, io } = sink();
  assert.equal(await keyLowAlert(db, state, NOW, io), 1);
  setBal('5j7JgE6w', 3000000);
  assert.equal(await keyLowAlert(db, state, NOW + 3600e3, io), 1);
  assert.match(sent[1], /1 Apify comp key is under/);
  assert.match(sent[1], /5j7JgE6w/);
  assert.doesNotMatch(sent[1], /Fss3nxHt/);
});

test('a failed send leaves the state alone so the next run retries', async () => {
  const { db, key } = fresh();
  key('Fss3nxHt', 'active', 1000000, 'apify-scholarly-paper-search');
  const state = {};
  assert.equal(await keyLowAlert(db, state, NOW, { send: async () => false, log: () => {} }), 0);
  assert.deepEqual(state.keyLow, {});
  const { sent, io } = sink();
  assert.equal(await keyLowAlert(db, state, NOW + 300e3, io), 1);
  assert.equal(sent.length, 1);
});

test('no api_keys table is not an error', async () => {
  const { db } = fresh({ keysTable: false });
  const { sent, io } = sink();
  assert.equal(await keyLowAlert(db, {}, NOW, io), 0);
  assert.equal(sent.length, 0);
});
