'use strict';
// batch-settlement (R5 A1) end to end with no chain: the real @x402/evm 2.28 batch CLIENT signs
// real deposits and vouchers, the real batch SERVER scheme verifies them behind
// @x402/express, channels live in lib/batch-storage.js (SQLite), and a stub facilitator plays
// CDP (deposit settles, claims). Proves: verify -> serve -> store -> claim; a handler >= 400
// never raises the claimable amount; vouchers survive a restart; a replayed or lower voucher
// is refused.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { BatchSettlementEvmScheme: ServerScheme } = require('@x402/evm/batch-settlement/server');
const { BatchSettlementEvmScheme: ClientScheme } = require('@x402/evm/batch-settlement/client');
const { wrapFetchWithPaymentFromConfig } = require('@x402/fetch');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { createSqliteChannelStorage } = require('../lib/batch-storage');

const NET = 'eip155:8453';
const RECEIVER = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const authorizer = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());

function stubFacilitator() {
  const log = { settles: [], claims: [] };
  return {
    log,
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: NET, extra: { receiverAuthorizer: authorizer.address } }], extensions: [], signers: {} };
    },
    async verify(payload) {
      return { isValid: true, payer: payer.address, extra: { balance: payload.payload.deposit ? payload.payload.deposit.amount : '1000000', totalClaimed: '0', withdrawRequestedAt: 0, refundNonce: 0 } };
    },
    async settle(payload, requirements) {
      const raw = payload.payload;
      if (raw.type === 'claim') { log.claims.push(raw); return { success: true, transaction: '0x' + 'c1'.repeat(32), network: NET, payer: RECEIVER }; }
      if (raw.type === 'settle') { return { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: RECEIVER }; }
      log.settles.push(raw.type);
      return { success: true, transaction: '0x' + 'd0'.repeat(32), network: NET, payer: payer.address, amount: requirements.amount,
        extra: { channelState: { balance: raw.deposit.amount, totalClaimed: '0', withdrawRequestedAt: 0, refundNonce: 0 } } };
    },
  };
}

function boot(dbFile, fac) {
  const db = new Database(dbFile);
  const storage = createSqliteChannelStorage(db, { network: NET });
  const scheme = new ServerScheme(RECEIVER, { receiverAuthorizerSigner: authorizer, withdrawDelay: 86400, storage });
  const rs = new x402ResourceServer([fac]).register(NET, scheme);
  const accepts = [{ scheme: 'batch-settlement', price: '$0.001', network: NET, payTo: RECEIVER }];
  const app = express();
  app.use(paymentMiddleware({ 'GET /ok': { accepts, description: 'ok' }, 'GET /fail': { accepts, description: 'fail' } }, rs));
  app.get('/ok', (req, res) => res.json({ ok: true }));
  app.get('/fail', (req, res) => res.status(500).json({ ok: false }));
  return { app, db, storage, scheme };
}
async function serve(t, app) { const s = app.listen(0); t.after(() => s.close()); await new Promise((r) => s.once('listening', r)); return `http://127.0.0.1:${s.address().port}`; }
const client = (storage) => wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: NET, client: new ClientScheme(payer, storage ? { storage } : undefined) }] });
const channelOf = async (storage) => (await storage.list())[0];

test('deposit, then vouchers: verified, served, charged and stored in SQLite; a 500 charges nothing', async (t) => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'batch-')), 'a.db');
  const fac = stubFacilitator();
  const { app, storage } = boot(dbFile, fac);
  const base = await serve(t, app);
  const pay = client();
  const r1 = await pay(`${base}/ok`);
  assert.equal(r1.status, 200, await r1.clone().text());
  let ch = await channelOf(storage);
  assert.equal(ch.chargedCumulativeAmount, '1000', 'first call charged 1000 units');
  assert.deepEqual(fac.log.settles, ['deposit']);
  const r2 = await pay(`${base}/ok`);
  assert.equal(r2.status, 200);
  ch = await channelOf(storage);
  assert.equal(ch.chargedCumulativeAmount, '2000', 'a voucher call adds the price');
  assert.deepEqual(fac.log.settles, ['deposit'], 'a voucher needs no facilitator settlement');
  const before = ch.chargedCumulativeAmount;
  const r3 = await pay(`${base}/fail`);
  assert.equal(r3.status, 500);
  ch = await channelOf(storage);
  assert.equal(ch.chargedCumulativeAmount, before, 'a 500 never raises what can be claimed');
  assert.equal(ch.pendingRequest, undefined, 'its reservation is released');
  const r4 = await pay(`${base}/ok`);
  assert.equal(r4.status, 200, 'the next call after a failure still pays');
  assert.equal((await channelOf(storage)).chargedCumulativeAmount, '3000');
});

test('vouchers survive a restart, and the claim redeems exactly the charged amount', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
  const dbFile = path.join(dir, 'b.db');
  const fac = stubFacilitator();
  const a = boot(dbFile, fac);
  const base = await serve(t, a.app);
  const pay = client();
  for (let i = 0; i < 3; i++) assert.equal((await pay(`${base}/ok`)).status, 200);
  a.db.close();
  // "restart": a new process opens the same file
  const b = boot(dbFile, fac);
  const ch = await channelOf(b.storage);
  assert.equal(ch.chargedCumulativeAmount, '3000');
  const mgr = b.scheme.createChannelManager(fac, NET);
  const out = await mgr.claimAndSettle({ maxClaimsPerBatch: 100 });
  assert.equal(out.claims.length, 1);
  assert.equal(fac.log.claims.length, 1);
  const claim = fac.log.claims[0].claims[0];
  assert.equal(claim.totalClaimed, '3000', 'claims the charged total, not the signed maximum');
  assert.ok(fac.log.claims[0].claimAuthorizerSignature, 'signed by our receiverAuthorizer');
  assert.equal((await channelOf(b.storage)).totalClaimed, '3000');
  assert.equal((await mgr.claim()).length, 0, 'nothing left to claim');
});

test('a replayed voucher and a lower voucher are refused, nothing charged', async (t) => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'batch-')), 'c.db');
  const fac = stubFacilitator();
  const { app, storage } = boot(dbFile, fac);
  const base = await serve(t, app);
  // capture what a client sends
  const sent = [];
  const spy = async (input, init) => {
    const h = input instanceof Request ? input.headers : new Headers(init && init.headers);
    if (h.get('payment-signature')) sent.push(h.get('payment-signature'));
    return fetch(input, init);
  };
  const reasonOf = (r) => { const pr = r.headers.get('payment-required'); return pr ? JSON.parse(Buffer.from(pr, 'base64').toString()).error : null; };
  const pay = wrapFetchWithPaymentFromConfig(spy, { schemes: [{ network: NET, client: new ClientScheme(payer) }] });
  assert.equal((await pay(`${base}/ok`)).status, 200);
  assert.equal((await pay(`${base}/ok`)).status, 200);
  const charged = (await channelOf(storage)).chargedCumulativeAmount;
  assert.equal(charged, '2000');
  // replay the second (voucher) payment exactly
  assert.equal(sent.length, 2, 'two payments captured');
  JSON.parse(Buffer.from(sent[1], 'base64').toString()); // a real, decodable payment
  const replay = await fetch(`${base}/ok`, { headers: { 'payment-signature': sent[1] } });
  assert.equal(replay.status, 402, 'replayed voucher refused');
  assert.match(String(reasonOf(replay)), /cumulative|mismatch|stale/i, `refused as a stale voucher, got ${reasonOf(replay)}`);
  // the first (deposit) payment carries a lower cumulative amount
  const lower = await fetch(`${base}/ok`, { headers: { 'payment-signature': sent[0] } });
  assert.equal(lower.status, 402, 'lower voucher refused');
  assert.match(String(reasonOf(lower)), /cumulative|mismatch|stale/i, `refused as a stale voucher, got ${reasonOf(lower)}`);
  assert.equal((await channelOf(storage)).chargedCumulativeAmount, charged, 'nothing charged by either');
});

test('storage: atomic update semantics, per-network isolation, delete', async () => {
  const db = new Database(':memory:');
  const s1 = createSqliteChannelStorage(db, { network: 'eip155:8453' });
  const s2 = createSqliteChannelStorage(db, { network: 'eip155:137' });
  const id = '0x' + 'ab'.repeat(32);
  assert.deepEqual(await s1.updateChannel(id, (c) => c), { channel: undefined, status: 'unchanged' });
  const up = await s1.updateChannel(id, () => ({ channelId: id, chargedCumulativeAmount: '5' }));
  assert.equal(up.status, 'updated');
  assert.equal((await s1.updateChannel(id, (c) => c)).status, 'unchanged');
  assert.equal(await s2.get(id), undefined, 'another network does not see it');
  assert.equal((await s1.get(id.toUpperCase().replace('0X', '0x'))).chargedCumulativeAmount, '5', 'ids are case-insensitive');
  assert.equal((await s1.updateChannel(id, () => undefined)).status, 'deleted');
  assert.equal((await s1.list()).length, 0);
});
