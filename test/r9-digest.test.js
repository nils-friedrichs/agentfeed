// test/r9-digest.test.js — the digest's prepaid-key lines (R9 K6): sold, drawn, owed; revenue unchanged; absent without the table.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { digestText, keysLines } = require('../ops/af-digest');
const { SCHEMA } = require('../lib/keys');

const CALLS = `CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, payer_wallet TEXT, tx_sig TEXT, amount_usdc REAL, status TEXT NOT NULL, latency_ms INTEGER, ip TEXT, error_msg TEXT, req_host TEXT, req_path TEXT, user_agent TEXT, method TEXT)`;
const FROM = Date.UTC(2026, 9, 13, 21, 0, 0), TO = FROM + 86400e3;
const W = { date: '2026-10-14', from: FROM, to: TO, hour: 9, today: '2026-10-14' };

function fresh({ keysTable = true } = {}) {
  const db = new Database(':memory:');
  db.exec(CALLS);
  if (keysTable) db.exec(SCHEMA);
  const call = db.prepare('INSERT INTO calls (ts, tool, payer_wallet, tx_sig, amount_usdc, status, ip) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const key = (...a) => db.prepare("INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, created, buyer) VALUES (?, ?, ?, ?, ?, 1, ?)").run(...a);
  return { db, call: (ts, tool, payer, amt, status) => call.run(ts, tool, payer, status === 'paid' ? '0xtx' : null, amt, status, '203.0.113.1'), key: (h, p, st, bal, buyer) => key(h, p, st, bal, 0, buyer) };
}

test('keys lines: sold, drawn and owed; comp-key calls are named and are not sales', () => {
  const { db, call, key } = fresh();
  call(FROM + 1e3, 'buy_key_trial', '0xaaa', 0.25, 'paid');
  call(FROM + 2e3, 'buy_key_1', '0xbbb', 1, 'paid');
  call(FROM + 3e3, 'topup_key_5', '0xaaa', 5, 'paid');
  call(FROM + 4e3, 'get_signal_board', 'key:BuyerKey', 0.005, 'key');
  call(FROM + 5e3, 'get_signal_board', 'key:BuyerKey', 0.005, 'key');
  call(FROM + 6e3, 'get_coin_signal', 'key:CompKey1', 0.002, 'key');
  call(TO + 1e3, 'get_signal_board', 'key:BuyerKey', 0.005, 'key');           // the next day: not counted
  key('h1', 'BuyerKey', 'active', 243000, 'x'); key('h2', 'CompKey1', 'active', 48000, 'grant'); key('h3', 'Revoked1', 'revoked', 99000, 'x');
  const [line] = keysLines(db, W);
  assert.match(line, /^Prepaid keys: sold 3 \(\$6\.250: buy_key_1 x1, buy_key_trial x1, topup_key_5 x1\)/);
  assert.match(line, /drawn 3 calls = \$0\.012 from 2 keys \(1 on comp keys, not sales\)/);
  assert.match(line, /still owed to 2 active keys: \$0\.291$/, 'a revoked key owes nothing');
});

test('digest: the line sits in the digest, key rows are not paid revenue, and nothing changes without the table', () => {
  const { db, call } = fresh();
  call(FROM + 1e3, 'buy_key_trial', '0xaaa', 0.25, 'paid');
  call(FROM + 2e3, 'get_signal_board', 'key:BuyerKey', 0.005, 'key');
  const text = digestText(db, W, false);
  assert.match(text, /Paid: 1 calls, \$0\.250 from 1 external payers/, 'the purchase is revenue; the key call is not added to it');
  assert.match(text, /Prepaid keys: sold 1 \(\$0\.250: buy_key_trial x1\); drawn 1 calls = \$0\.005 from 1 key; still owed to 0 active keys: \$0\.000/);
  const bare = fresh({ keysTable: false });
  assert.deepEqual(keysLines(bare.db, W), [], 'before the table exists (an old copy, or before the first boot) the section is absent');
  assert.ok(!/Prepaid keys/.test(digestText(bare.db, W, false)));
});
