'use strict';
// test/batch-resync.test.js — R8 (13 Oct 2026): a claim run never breaks an open batch-settlement channel, and a client with no
// memory of the channel resyncs inside the same request.
//
// Why this exists. During the proof top-up two requests (audit rows 11994 and 11997) were refused with
// invalid_batch_settlement_evm_cumulative_amount_mismatch from the box's own client. The question was whether a claim run (or any
// server-side change) can desync a live channel, in which case every high-frequency buyer would meet refusals every 30 minutes.
//
// What the code says: the server compares the voucher with ONE number, the channel's chargedCumulativeAmount (server beforeVerify:
// expected = charged + price). A claim changes totalClaimed and never chargedCumulativeAmount, and the channel store updates inside
// BEGIN IMMEDIATE (lib/batch-storage.js), so the cron and the server serialize. The mismatch appears only when the CLIENT's baseline is
// wrong: a client with no stored context rebuilds it from the chain (recoverChannel: charged := the chain's totalClaimed), which is
// behind the server whenever vouchers are outstanding. The standard client then takes the corrective 402 (it carries the server's
// charged total and its signed voucher), resyncs and retries inside the same fetch(): the buyer sees a 200.
//
// Everything below is the real @x402/evm batch CLIENT and SERVER scheme behind @x402/express, the real SQLite channel store, and a
// stub facilitator that plays CDP including its claim minimum. No chain, no money.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
const MISMATCH = 'invalid_batch_settlement_evm_cumulative_amount_mismatch';
const authorizer = privateKeyToAccount(generatePrivateKey());
const payerKey = generatePrivateKey();

/** A stub facilitator that keeps the channel's on-chain numbers (balance, totalClaimed) and refuses a claim below `minClaim`, as CDP does. */
function chainFacilitator({ minClaim = 0n } = {}) {
  const chain = { balance: 0n, totalClaimed: 0n };
  const log = { claims: 0, refusedClaims: 0, deposits: 0 };
  const payer = privateKeyToAccount(payerKey);
  return {
    chain, log,
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: NET, extra: { receiverAuthorizer: authorizer.address } }], extensions: [], signers: {} }; },
    async verify(payload) {
      const dep = payload.payload.deposit;
      return { isValid: true, payer: payer.address, extra: { balance: dep ? dep.amount : String(chain.balance), totalClaimed: String(chain.totalClaimed), withdrawRequestedAt: 0, refundNonce: 0 } };
    },
    async settle(payload, requirements) {
      const raw = payload.payload;
      if (raw.type === 'claim') {
        const delta = raw.claims.reduce((a, c) => a + (BigInt(c.totalClaimed) - chain.totalClaimed), 0n);
        if (delta < minClaim) { log.refusedClaims++; return { success: false, errorReason: 'amount_too_low', transaction: '', network: NET }; }
        for (const c of raw.claims) if (BigInt(c.totalClaimed) > chain.totalClaimed) chain.totalClaimed = BigInt(c.totalClaimed);
        log.claims++;
        return { success: true, transaction: '0x' + 'c1'.repeat(32), network: NET, payer: RECEIVER };
      }
      if (raw.type === 'settle') return { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: RECEIVER };
      chain.balance += BigInt(raw.deposit.amount); // a deposit
      log.deposits++;
      return { success: true, transaction: '0x' + 'd0'.repeat(32), network: NET, payer: payer.address, amount: requirements.amount,
        extra: { channelState: { balance: String(chain.balance), totalClaimed: String(chain.totalClaimed), withdrawRequestedAt: 0, refundNonce: 0 } } };
    },
  };
}

function boot(dbFile, fac, price, minDeposit) {
  const db = new Database(dbFile);
  const storage = createSqliteChannelStorage(db, { network: NET });
  const scheme = new ServerScheme(RECEIVER, { receiverAuthorizerSigner: authorizer, withdrawDelay: 86400, storage });
  const rs = new x402ResourceServer([fac]).register(NET, scheme);
  const app = express();
  app.use(paymentMiddleware({ 'GET /ok': { accepts: [{ scheme: 'batch-settlement', price, network: NET, payTo: RECEIVER, ...(minDeposit ? { extra: { minDeposit } } : {}) }], description: 'ok' } }, rs));
  app.get('/ok', (req, res) => res.json({ ok: true }));
  return { app, db, storage, scheme };
}
async function serve(t, app) { const s = app.listen(0); t.after(() => s.close()); await new Promise((r) => s.once('listening', r)); return `http://127.0.0.1:${s.address().port}`; }
const channelOf = async (storage) => (await storage.list())[0];

/** A fetch that counts what the buyer's client met on the wire: corrective 402s to a PAID request. */
function spyFetch() {
  const seen = { corrective: 0, paidRequests: 0 };
  const fn = async (input, init) => {
    const h = input instanceof Request ? input.headers : new Headers(init && init.headers);
    const paid = !!h.get('payment-signature');
    const res = await fetch(input, init);
    if (paid) {
      seen.paidRequests++;
      const pr = res.status === 402 ? res.headers.get('payment-required') : null;
      if (pr && JSON.parse(Buffer.from(pr, 'base64').toString()).error === MISMATCH) seen.corrective++;
    }
    return res;
  };
  return { fn, seen };
}

test('one client context pays straight through claim runs, sequential and from another process: no corrective 402, nothing desynced', async (t) => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resync-')), 'a.db');
  const fac = chainFacilitator();
  const { app, storage, scheme } = boot(dbFile, fac, '$0.001', '100000'); // a deposit big enough for the whole run: one channel, no top-up
  const base = await serve(t, app);
  const mgr = scheme.createChannelManager(fac, NET);
  const spy = spyFetch();
  const pay = wrapFetchWithPaymentFromConfig(spy.fn, { schemes: [{ network: NET, client: new ClientScheme(privateKeyToAccount(payerKey)) }] });
  const CALLS = 24;
  // a second process claiming over and over from the same file while the calls go on, as ops/batch-claim.js does every 30 min
  const child = spawn(process.execPath, [path.join(__dirname, 'helpers', 'claim-loop.js'), dbFile, '2500'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });
  const childDone = new Promise((r) => child.on('close', r));
  let claimedSeq = 0;
  for (let i = 1; i <= CALLS; i++) {
    const res = await pay(`${base}/ok`);
    assert.equal(res.status, 200, `call ${i} must be served (got ${res.status})`);
    const ch = await channelOf(storage);
    assert.equal(ch.chargedCumulativeAmount, String(i * 1000), `after call ${i} the server charged exactly ${i} prices: a claim never moves it`);
    assert.ok(BigInt(ch.totalClaimed) <= BigInt(ch.chargedCumulativeAmount), 'claimed never runs ahead of charged');
    if (i % 6 === 0) { claimedSeq += (await mgr.claim({ maxClaimsPerBatch: 100 })).length; } // and a sequential claim run in this process too
    await new Promise((r) => setTimeout(r, 40));
  }
  await childDone;
  assert.match(childOut, /claimed \d+ batches in \d+ attempts/, `the other process ran: ${childOut}`);
  const claimedByChild = Number((childOut.match(/claimed (\d+) batches/) || [])[1]);
  t.diagnostic(`other process: ${childOut.trim()}; sequential claim batches in this process: ${claimedSeq}; corrective 402s met by the buyer: ${spy.seen.corrective}`);
  assert.ok(claimedByChild + claimedSeq >= 3, `claim runs really happened during the calls (child ${claimedByChild}, here ${claimedSeq})`);
  assert.equal(spy.seen.corrective, 0, 'the buyer met no corrective 402 at any point, before, during or after a claim');
  assert.equal(spy.seen.paidRequests, CALLS, 'exactly one paid request per call: none was sent twice');
  const ch = await channelOf(storage);
  assert.equal(ch.chargedCumulativeAmount, String(CALLS * 1000));
  assert.equal(ch.pendingRequest, undefined, 'no reservation left behind');
});

test('a client with no memory of the channel (fresh per call) meets a corrective 402 exactly when vouchers are outstanding, resyncs in the same request, and every call is a 200', async (t) => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resync-')), 'b.db');
  const fac = chainFacilitator({ minClaim: 1000n }); // CDP refuses a claim below 0.001: with a 0.0005 price every second voucher is claimable
  const { app, storage, scheme } = boot(dbFile, fac, '$0.0005');
  const base = await serve(t, app);
  const mgr = scheme.createChannelManager(fac, NET);
  const readContract = async ({ functionName }) => { assert.equal(functionName, 'channels'); return [fac.chain.balance, fac.chain.totalClaimed]; };
  const statelessCall = async () => {
    const spy = spyFetch();
    const signer = Object.assign(privateKeyToAccount(payerKey), { readContract }); // chain recovery, as the proof script's client does
    const pay = wrapFetchWithPaymentFromConfig(spy.fn, { schemes: [{ network: NET, client: new ClientScheme(signer) }] });
    const res = await pay(`${base}/ok`);
    return { status: res.status, corrective: spy.seen.corrective };
  };
  // open the channel and bring charged == claimed, as it stood before the proof top-up
  const opener = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: NET, client: new ClientScheme(privateKeyToAccount(payerKey)) }] });
  for (let i = 0; i < 4; i++) assert.equal((await opener(`${base}/ok`)).status, 200);
  assert.equal((await mgr.claim()).length, 1);
  let ch = await channelOf(storage);
  assert.deepEqual([ch.chargedCumulativeAmount, ch.totalClaimed, String(fac.chain.totalClaimed)], ['2000', '2000', '2000']);

  const results = [];
  for (let i = 1; i <= 5; i++) {
    results.push(await statelessCall());
    try { await mgr.claim(); } catch { /* a claim below the minimum is refused, as on 13 Oct */ }
  }
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200], 'the buyer is served every time');
  assert.deepEqual(results.map((r) => r.corrective), [0, 1, 0, 1, 0], 'a corrective 402 only on the calls that started with a voucher outstanding (13 Oct: rows 11994 and 11997)');
  ch = await channelOf(storage);
  assert.equal(ch.chargedCumulativeAmount, String(2000 + 5 * 500), 'five calls charged five prices, none twice');
  assert.equal(fac.log.refusedClaims, 3, 'the claims of 0.0005 were refused, the claims of 0.0010 went through');
  assert.equal(String(fac.chain.totalClaimed), '4000');
});

test('the same fresh client after every voucher has been claimed meets nothing at all', async (t) => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'resync-')), 'c.db');
  const fac = chainFacilitator();
  const { app, storage, scheme } = boot(dbFile, fac, '$0.001');
  const base = await serve(t, app);
  const mgr = scheme.createChannelManager(fac, NET);
  const readContract = async () => [fac.chain.balance, fac.chain.totalClaimed];
  const opener = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: NET, client: new ClientScheme(privateKeyToAccount(payerKey)) }] });
  assert.equal((await opener(`${base}/ok`)).status, 200);
  await mgr.claim();
  for (let i = 0; i < 4; i++) {
    const spy = spyFetch();
    const pay = wrapFetchWithPaymentFromConfig(spy.fn, { schemes: [{ network: NET, client: new ClientScheme(Object.assign(privateKeyToAccount(payerKey), { readContract })) }] });
    assert.equal((await pay(`${base}/ok`)).status, 200);
    assert.equal(spy.seen.corrective, 0, `call ${i + 1}: nothing outstanding, nothing to resync`);
    await mgr.claim(); // claim after every call, the most frequent a cron could ever be
  }
  assert.equal((await channelOf(storage)).chargedCumulativeAmount, '5000');
});
