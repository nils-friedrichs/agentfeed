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

// ---- R14 (18 Oct 2026): the Gateway accept is on Arc only --------------------------------------------------------------------
// Buyers (Bun/1.4.2 on x402 v1, python-httpx: rows 14355-14361 and 14588) picked the half-price GatewayWalletBatched accept of
// Base, signed a plain EIP-3009 authorization to the Gateway wallet, and were refused. The accept is gone from the default
// challenge on Base, Polygon and Arbitrum, in the v2 header and in the v1 body derived from it, and kept on Arc.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { generatePrivateKey } = require('viem/accounts');
const { x402ResourceServer } = require('@x402/core/server');
const { x402Client } = require('@x402/core/client');
const { ExactEvmScheme: ExactEvmServer } = require('@x402/evm/exact/server');
const { ExactEvmScheme: ExactEvmClient } = require('@x402/evm/exact/client');
const { hfConfig, GATEWAY_NETWORKS, BATCH_NETWORKS } = require('../lib/hf');
const { makeV1 } = require('../lib/x402v1');

const TREASURY = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const BASE = 'eip155:8453', POLYGON = 'eip155:137', ARBITRUM = 'eip155:42161', ARC = 'eip155:5042';
const isGateway = (a) => !!(a.extra && a.extra.name === 'GatewayWalletBatched');

function realCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-r14-'));
  const auth = path.join(dir, 'batch-authorizer.key'), gw = path.join(dir, 'gateway-seller.key');
  fs.writeFileSync(auth, generatePrivateKey()); fs.writeFileSync(gw, generatePrivateKey());
  return hfConfig({ PAY_TO_EVM: TREASURY, BATCH_AUTHORIZER_KEY: auth, GATEWAY_SELLER_KEY: gw });
}

// the 402 accepts of a priced route as the resource server builds them: the exact rails first, then the half-price tier (the order
// payments.routeAccepts gives), through the real x402ResourceServer so amounts, assets and extra are what a buyer sees
async function accepts(cfg, usd = 0.001) {
  const fac = { getSupported: async () => ({ kinds: [BASE, POLYGON, ARBITRUM, ARC].map((network) => ({ x402Version: 2, scheme: 'exact', network })), extensions: [], signers: {} }), verify: async () => ({ isValid: true }), settle: async () => ({ success: true }) };
  const rs = new x402ResourceServer([fac]);
  for (const n of [BASE, POLYGON, ARBITRUM, ARC]) rs.register(n, new ExactEvmServer());
  await rs.initialize();
  const arcPrice = { amount: String(Math.round(usd * 1e6)), asset: '0x3600000000000000000000000000000000000000', extra: { name: 'USDC', version: '2' } };
  const configs = [
    ...[BASE, POLYGON, ARBITRUM].map((network) => ({ scheme: 'exact', network, payTo: TREASURY, price: `$${usd}` })),
    { scheme: 'exact', network: ARC, payTo: '0x0Cf44185564F2b72E291050DC79E578429E52f83', price: arcPrice },
    ...hfAccepts(cfg, usd).filter((a) => a.scheme === 'exact'), // batch-settlement needs a client scheme a stock client does not register
  ];
  const out = [];
  for (const c of configs) out.push(...(await rs.buildPaymentRequirements(c)));
  return out;
}

test('the real tier: Gateway on Arc only, batch-settlement on its three chains, one Gateway accept per route', () => {
  assert.deepEqual(GATEWAY_NETWORKS, [ARC]);
  assert.deepEqual(BATCH_NETWORKS, [BASE, POLYGON, ARBITRUM]);
  const cfg = realCfg();
  assert.deepEqual(cfg.gateway.networks, [ARC]);
  const a = hfAccepts(cfg, 0.01);
  assert.deepEqual(a.filter((x) => x.scheme === 'batch-settlement').map((x) => x.network), [BASE, POLYGON, ARBITRUM], 'batch-settlement is left as it was');
  assert.deepEqual(a.filter(isGateway).map((x) => x.network), [ARC]);
  assert.equal(a.filter(isGateway)[0].payTo, cfg.gateway.payTo);
});

test('a buyer that takes the cheapest accept of its chain pays the ordinary Base accept; before R14 it took the Gateway accept (control)', async () => {
  const cheapest = (_v, list) => list.reduce((m, a) => (BigInt(a.amount) < BigInt(m.amount) ? a : m));
  const signer = { address: '0x' + 'ab'.repeat(20), signTypedData: async () => '0x' };
  const buyers = {
    'stock @x402/fetch selector (first accept)': () => new x402Client().register(BASE, new ExactEvmClient(signer)),
    'cheapest-accept selector': () => new x402Client(cheapest).register(BASE, new ExactEvmClient(signer)),
  };
  const now = realCfg();
  const before = { ...now, gateway: { ...now.gateway, networks: [BASE, POLYGON, ARBITRUM, ARC] } };   // the pre-R14 set
  const listNow = await accepts(now), listBefore = await accepts(before);
  assert.equal(listNow.filter(isGateway).length, 1, 'one Gateway accept left, on Arc');
  assert.equal(listBefore.filter(isGateway).length, 4, 'the control carries the four of before');
  for (const [name, make] of Object.entries(buyers)) {
    const pick = make().selectPaymentRequirements(2, listNow);
    assert.equal(pick.network, BASE, name);
    assert.ok(!isGateway(pick), `${name}: the ordinary accept`);
    assert.equal(pick.payTo, TREASURY, name);
    assert.equal(pick.amount, '1000', `${name}: the list price`);
    assert.equal(pick.extra.name, 'USD Coin', name);
  }
  assert.ok(isGateway(buyers['cheapest-accept selector']().selectPaymentRequirements(2, listBefore)), 'control: before R14 the cheapest-accept buyer took the Gateway accept');
  assert.ok(!isGateway(buyers['stock @x402/fetch selector (first accept)']().selectPaymentRequirements(2, listBefore)), 'control: the stock selector was never affected');
});

test('a buyer on Polygon or Arbitrum sees no Gateway accept either', async () => {
  const list = await accepts(realCfg());
  for (const n of [POLYGON, ARBITRUM]) assert.deepEqual(list.filter((a) => a.network === n).map((a) => a.extra.name), ['USD Coin'], n);
  assert.deepEqual(list.filter((a) => a.network === ARC).map((a) => a.extra.name), ['USDC', 'GatewayWalletBatched'], 'Arc keeps its ordinary accept and the Gateway one, in that order');
});

test('the v1 body is built from the v2 header, so it has no Gateway accept on Base either; before R14 it had one (control)', async (t) => {
  const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  async function body(list) {
    const v1 = makeV1({});
    const app = express();
    app.use(v1.challengeBody);
    app.use((_req, res) => {
      res.setHeader('PAYMENT-REQUIRED', b64({ x402Version: 2, error: 'Payment required', resource: { url: 'https://x402.ochinimus.app/api/sol-price', description: 'x', mimeType: 'application/json' }, accepts: list }));
      res.status(402).json({});
    });
    await v1.bind({ routes: { 'GET /api/sol-price': { accepts: [] } }, resourceServer: {}, facilitator: { getSupported: async () => ({ kinds: [{ x402Version: 1, scheme: 'exact', network: 'solana', extra: { feePayer: 'F' } }, { x402Version: 1, scheme: 'exact', network: 'base' }] }) } });
    const srv = app.listen(0); t.after(() => srv.close());
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/sol-price`);
    return { header: JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString()), v1: await r.json() };
  }
  const solana = { scheme: 'exact', network: SOL, amount: '1000', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'TREASURYsol', maxTimeoutSeconds: 300, extra: { name: 'USDC', feePayer: 'X' } };
  const now = realCfg();
  const before = { ...now, gateway: { ...now.gateway, networks: [BASE, POLYGON, ARBITRUM, ARC] } };
  const a = await body([solana, ...(await accepts(now))]);
  assert.equal(a.header.accepts.filter(isGateway).filter((x) => x.network !== ARC).length, 0, 'v2 header: none on Base, Polygon or Arbitrum');
  assert.deepEqual(a.v1.accepts.map((x) => [x.network, x.extra.name]), [['solana', 'USDC'], ['base', 'USD Coin']], 'v1 body: Solana and the ordinary Base accept only');
  const c = await body([solana, ...(await accepts(before))]);
  assert.deepEqual(c.v1.accepts.map((x) => x.extra.name), ['USDC', 'USD Coin', 'GatewayWalletBatched'], 'control: the v1 body of before carried the Gateway accept on base');
});
