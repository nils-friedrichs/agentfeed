// R9 K1: ops/key-admin.mjs against a scratch database (AGENTFEED_DB), never the live one.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { hashKey, KEY_RE } = require('../lib/keys');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-keyadmin-'));
const DB = path.join(dir, 'agentfeed.db');
const CLI = path.join(__dirname, '..', 'ops', 'key-admin.mjs');
const run = (...a) => execFileSync(process.execPath, [CLI, ...a], { env: { ...process.env, AGENTFEED_DB: DB }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fail = (...a) => { try { run(...a); } catch (e) { return String(e.stderr); } throw new Error('expected a refusal'); };

test.before(() => { new Database(DB).close(); });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('grant --out writes the key mode 600 and prints only its prefix; list, set-rate, revoke', () => {
  const out = path.join(dir, 'proof.key');
  const said = run('grant', '0.05', '--label', 'r9-proof', '--out', out);
  const key = fs.readFileSync(out, 'utf8').trim();
  assert.match(key, KEY_RE);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.ok(!said.includes(key), 'the key is not on stdout');
  assert.ok(said.includes(key.slice(4, 12)));
  const db = new Database(DB, { readonly: true });
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(key));
  db.close();
  assert.equal(row.status, 'active');
  assert.equal(row.balance_micro, 50_000);
  assert.equal(row.sold_micro, 0, 'a comp key is not a sale');
  assert.equal(row.buyer, 'grant');
  const list = run('list');
  assert.ok(list.includes(key.slice(4, 12)) && list.includes('r9-proof') && !list.includes(key));
  assert.match(run('set-rate', key.slice(4, 12), '600'), /120 -> 600/);
  assert.match(run('revoke', key.slice(4, 12)), /revoked/);
  assert.match(run('list'), /revoked/);
  assert.match(fail('grant', '0.05', '--label', 'x', '--out', out), /exists/);
});

test('grant without --out prints the key once; refusals for bad input', () => {
  const said = run('grant', '1', '--label', 'partner');
  const m = /key \(shown once, not stored anywhere\): (afk_\S+)/.exec(said);
  assert.ok(m && KEY_RE.test(m[1]));
  assert.match(fail('grant', '1'), /--label/);
  assert.match(fail('grant', '101', '--label', 'x'), /at most 100/);
  assert.match(fail('set-rate', m[1].slice(4, 12), '0'), /1 to 6000/);
  assert.match(fail('revoke', 'zzzzzzzz'), /no key/);
  assert.match(fail('revoke', 'abc'), /6 characters/);
  assert.match(fail('nope'), /usage/);
});
