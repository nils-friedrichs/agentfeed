'use strict';
// R4: the Arc rail's Circle Facilitator Service client, against a stub facilitator.
// Arc-only /supported, the keyless seller proof (EIP-712 over the exact raw body), Bearer
// with an API key, pending -> /status reconciliation, and a spent trial (403).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const V = require('viem');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');

function stub(t, behaviour) {
  const app = express();
  const seen = [];
  app.use(express.raw({ type: '*/*' }));
  app.use((req, _res, next) => { seen.push({ method: req.method, path: req.path, headers: req.headers, body: req.body && req.body.length ? req.body.toString() : '' }); next(); });
  app.get('/supported', (_req, res) => res.json({ x402Version: 2, kinds: [
    { x402Version: 2, scheme: 'exact', network: 'eip155:5042', asset: '0x3600000000000000000000000000000000000000', extra: { name: 'USDC', version: '2' } },
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:137', asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  ], extensions: ['settlement-status'], signers: {} }));
  app.post('/verify', (_req, res) => res.json({ isValid: true, payer: '0x9aE2000000000000000000000000000000000001' }));
  app.post('/settle', (req, res) => behaviour.settle(req, res));
  app.get('/status/:id', (req, res) => behaviour.status(req, res));
  const srv = app.listen(0); t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}`, seen };
}

function setup(t, behaviour, extraEnv = {}) {
  const key = generatePrivateKey();
  const file = path.join(os.tmpdir(), `arc-key-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  const log = file + '.pending.jsonl';
  t.after(() => { fs.rmSync(file, { force: true }); fs.rmSync(log, { force: true }); });
  const s = stub(t, behaviour);
  const { CircleArcFacilitator } = require('../lib/circle-arc');
  const c = new CircleArcFacilitator({ env: { ARC_PAYTO_KEY: file, CIRCLE_FACILITATOR_URL: s.url, ARC_PENDING_LOG: log, ...extraEnv }, pollMs: 10, polls: 3 });
  return { c, s, address: privateKeyToAccount(key).address, log };
}

const payload = { x402Version: 2, accepted: { network: 'eip155:5042' }, payload: { signature: '0xab', authorization: { value: '5000' } }, resource: { url: 'https://x/api/perp' } };
const reqs = { scheme: 'exact', network: 'eip155:5042', amount: '5000', asset: '0x3600000000000000000000000000000000000000', payTo: '0x0', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };

test('Circle advertises Arc only, so it can never take Base or Polygon from CDP', async (t) => {
  const { c } = setup(t, {});
  const s = await c.getSupported();
  assert.deepStrictEqual(s.kinds.map((k) => k.network), ['eip155:5042']);
});

test('keyless: every call carries a seller proof that recovers to payTo and signs the exact raw body', async (t) => {
  const { c, s, address } = setup(t, { settle: (_q, r) => r.json({ success: true, payer: '0x1', transaction: '0xabc', network: 'eip155:5042' }) });
  assert.equal(c.mode, 'keyless-trial');
  const out = await c.settle(payload, { ...reqs, payTo: address });
  assert.equal(out.success, true);
  const call = s.seen.find((x) => x.path === '/settle');
  assert.ok(!call.headers.authorization, 'no Bearer without an API key');
  const env = JSON.parse(Buffer.from(call.headers['facilitator-seller-proof'], 'base64url').toString());
  assert.equal(env.version, 1); assert.equal(env.network, 'eip155:5042'); assert.equal(env.payTo, address);
  assert.ok(env.expiresAt - env.issuedAt <= 300 && env.expiresAt > Math.floor(Date.now() / 1000));
  const ok = await V.verifyTypedData({
    address,
    domain: { name: 'Circle Facilitator Seller Request', version: '1', chainId: 5042 },
    types: { SellerRequest: [{ name: 'purpose', type: 'string' }, { name: 'method', type: 'string' }, { name: 'bodyHash', type: 'bytes32' }, { name: 'network', type: 'string' }, { name: 'payTo', type: 'address' }, { name: 'nonce', type: 'bytes32' }, { name: 'issuedAt', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' }] },
    primaryType: 'SellerRequest',
    message: { purpose: 'settle', method: 'POST', bodyHash: V.keccak256(V.toBytes(call.body)), network: env.network, payTo: env.payTo, nonce: env.nonce, issuedAt: BigInt(env.issuedAt), expiresAt: BigInt(env.expiresAt) },
    signature: env.signature,
  });
  assert.ok(ok, 'signature verifies over keccak256(raw body)');
});

test('with CIRCLE_API_KEY: Bearer, and no seller proof', async (t) => {
  const { c, s } = setup(t, { settle: (_q, r) => r.json({ success: true, payer: '0x1', transaction: '0xabc', network: 'eip155:5042' }) }, { CIRCLE_API_KEY: 'TEST_API_KEY:abc:def' });
  assert.equal(c.mode, 'api-key');
  await c.verify(payload, reqs);
  const call = s.seen.find((x) => x.path === '/verify');
  assert.equal(call.headers.authorization, 'Bearer TEST_API_KEY:abc:def');
  assert.ok(!call.headers['facilitator-seller-proof']);
});

const pending = (_q, r) => r.json({ success: false, errorReason: 'settlement_pending', payer: '0x1', transaction: '', network: 'eip155:5042',
  extensions: { 'settlement-status': { status: 'pending', paymentId: '5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3aa' } } });

test('pending then completed on /status: released as a success with the transaction', async (t) => {
  let n = 0;
  const { c, s } = setup(t, { settle: pending, status: (_q, r) => r.json({ paymentId: 'x', status: ++n < 2 ? 'pending' : 'completed', transaction: '0xdef', network: 'eip155:5042', payer: '0x1', amount: '5000' }) });
  const out = await c.settle(payload, reqs);
  assert.deepStrictEqual([out.success, out.transaction], [true, '0xdef']);
  const st = s.seen.find((x) => x.path.startsWith('/status/'));
  const env = JSON.parse(Buffer.from(st.headers['facilitator-seller-proof'], 'base64url').toString());
  assert.equal(st.method, 'GET'); assert.ok(env.signature);
});

test('still pending after the polls: withheld (success false) and logged for reconciliation', async (t) => {
  const { c, log } = setup(t, { settle: pending, status: (_q, r) => r.json({ paymentId: 'x', status: 'pending', network: 'eip155:5042' }) });
  const out = await c.settle(payload, reqs);
  assert.equal(out.success, false); assert.equal(out.errorReason, 'settlement_pending');
  const row = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(row.paymentId, '5b3f6c1e-9d2a-4f08-b1c7-2e9a14d0c3aa'); assert.equal(row.amount, '5000');
});

test('failed on /status is a failure; a spent keyless trial (403) throws with its reason', async (t) => {
  const a = setup(t, { settle: pending, status: (_q, r) => r.json({ paymentId: 'x', status: 'failed', network: 'eip155:5042' }) });
  assert.equal((await a.c.settle(payload, reqs)).success, false);
  const b = setup(t, { settle: (_q, r) => r.status(403).json({ code: 403, message: 'Registration required to continue settling on this address', errors: [{ reason: 'registration_required' }] }) });
  await assert.rejects(b.c.settle(payload, reqs), /403 registration_required/);
});

test('rails: Arc is listed only with its key file, pays its own EOA and names its asset', () => {
  const R = require('../lib/rails');
  const env = { PAY_TO_EVM: '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6', ARC_PAYTO_KEY: '/nonexistent/arc.key' };
  assert.ok(!R.evmRails(env).some((r) => r.network === 'eip155:5042'), 'no key file, no Arc');
  const key = generatePrivateKey();
  const file = path.join(os.tmpdir(), `arc-rail-${process.pid}`); fs.writeFileSync(file, key, { mode: 0o600 });
  try {
    const arc = R.evmRails({ ...env, ARC_PAYTO_KEY: file }).find((r) => r.network === 'eip155:5042');
    assert.equal(R.railPayTo(arc, env), privateKeyToAccount(key).address);
    assert.notEqual(R.railPayTo(arc, env), env.PAY_TO_EVM, 'never the treasury');
    assert.deepStrictEqual(R.railPrice(arc, 0.005), { amount: '5000', asset: '0x3600000000000000000000000000000000000000', extra: { name: 'USDC', version: '2' } });
    assert.equal(R.railPrice(R.evmRails(env)[0], 0.005), '$0.005');
    assert.ok(!R.evmRails({ ...env, ARC_PAYTO_KEY: file, X402_ARC: 'off' }).some((r) => r.network === 'eip155:5042'), 'X402_ARC=off');
  } finally { fs.rmSync(file, { force: true }); }
});
