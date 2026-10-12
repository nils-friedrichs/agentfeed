'use strict';
// lib/hf.js (R5 A1/A2): the high-frequency accepts and the Gateway router.
const test = require('node:test');
const assert = require('node:assert');
const { hfUsd, hfAccepts, routeGateway, GATEWAY_WALLET } = require('../lib/hf');
const { isBatchPayment } = require('@circle-fin/x402-batching/server');

test('price: half the exact price, never below $0.0005', () => {
  assert.equal(hfUsd(0.001), 0.0005);
  assert.equal(hfUsd(0.0005), 0.0005);
  assert.equal(hfUsd(0.005), 0.0025);
  assert.equal(hfUsd(0.1), 0.05);
});

test('accepts: batch on Base/Polygon/Arbitrum to the treasury, Gateway on four chains to the seller key', () => {
  const cfg = { batch: { networks: ['eip155:8453', 'eip155:137', 'eip155:42161'], receiver: '0xTREASURY' },
    gateway: { networks: ['eip155:8453', 'eip155:137', 'eip155:42161', 'eip155:5042'], payTo: '0xSELLER' } };
  const a = hfAccepts(cfg, 0.01);
  assert.equal(a.length, 7);
  assert.deepEqual(a.slice(0, 3).map((x) => [x.scheme, x.price, x.payTo]), [['batch-settlement', '$0.005', '0xTREASURY'], ['batch-settlement', '$0.005', '0xTREASURY'], ['batch-settlement', '$0.005', '0xTREASURY']]);
  for (const g of a.slice(3)) {
    assert.equal(g.scheme, 'exact'); assert.equal(g.payTo, '0xSELLER'); assert.equal(g.maxTimeoutSeconds, 604900);
    assert.deepEqual(g.extra, { name: 'GatewayWalletBatched', version: '1', verifyingContract: GATEWAY_WALLET });
  }
  assert.deepEqual(hfAccepts({ batch: null, gateway: null }, 0.01), []);
});

test('router: Gateway payments go to Circle Gateway, CDP exact stays on CDP, other members pass through', async () => {
  const seen = [];
  const inner = { name: 'cdp', getSupported: async () => ({ kinds: ['cdp'] }), verify: async () => (seen.push('cdp.verify'), { isValid: true }), settle: async () => (seen.push('cdp.settle'), { success: true }) };
  const gw = { verify: async () => (seen.push('gw.verify'), { isValid: true }), settle: async () => (seen.push('gw.settle'), { success: true }) };
  const r = routeGateway(inner, gw, isBatchPayment);
  const cdpReq = { scheme: 'exact', network: 'eip155:8453', extra: { name: 'USD Coin', version: '2' } };
  const gwReq = { scheme: 'exact', network: 'eip155:8453', extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: GATEWAY_WALLET } };
  await r.verify({}, cdpReq); await r.settle({}, cdpReq);
  await r.verify({}, gwReq); await r.settle({}, gwReq);
  assert.deepEqual(seen, ['cdp.verify', 'cdp.settle', 'gw.verify', 'gw.settle']);
  assert.deepEqual(await r.getSupported(), { kinds: ['cdp'] }, 'the inner client still answers /supported');
  assert.equal(r.name, 'cdp');
});
