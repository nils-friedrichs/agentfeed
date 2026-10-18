// lib/hf.js — the high-frequency tier (R5 A1, A2): cheaper accepts for bots that call often.
//
// BATCH-SETTLEMENT (CDP, Base/Polygon/Arbitrum). The payer opens a channel with one deposit;
// every call after that is an off-chain voucher, verified here for free; the claim cron
// (ops/batch-claim.js) redeems the vouchers in one transaction. CDP /supported listed
// batch-settlement on eip155:8453, 137, 42161 and 480 on 2026-10-12. World (480) is left
// out: @x402/evm 2.28's default asset table has no eip155:480 entry.
//   receiver   PAY_TO_EVM (the treasury 0x22DB…76e6, whose key is never on this box)
//   authorizer /root/.config/agentfeed/batch-authorizer.key (signs claim authorizations;
//              holds no funds)
//   storage    agentfeed.db table batch_channels (lib/batch-storage.js), survives restarts
//   >= 400     the scheme's payment flow is "authorization": verified before the handler,
//              settled after it, and @x402/express cancels instead of settling when the
//              handler answers >= 400. Only settlement raises chargedCumulativeAmount, and a
//              claim redeems chargedCumulativeAmount, never the voucher's signed maximum.
//
// GATEWAY (Circle Gateway nanopayments, Arc ONLY since 18 Oct 2026). An `exact` accept whose
// extra names GatewayWalletBatched; Circle batches the EIP-3009 authorizations itself.
//   Base, Polygon and Arbitrum were dropped from this tier: the accept sits beside the chain's ordinary exact accept at half the
//   price, and real buyers picked it (apparently by lowest price; the stock @x402/fetch 2.28 takes the first accept and is not
//   affected) and signed a plain EIP-3009 authorization to the Gateway wallet, which is not a Gateway payment (that is a
//   different typed-data signature) and is refused. Rows 14355-14361 (0x69e1a9d8..., Oct 17 07:54 UTC: liq-feed twice,
//   /api/liquidations five times, x402 v1, "recipient mismatch 0xA853 != 0x22DB") and row 14588 (0x611cc522..., Oct 17 23:31 UTC:
//   sol-price, amount 500, payTo 0xA853..., maxTimeoutSeconds 604900, invalid_signature). No outside Gateway payment had ever
//   settled. The Arc accept stays: the Circle Gateway grant cites the Arc Gateway price, and ops/proof-gateway.mjs pays it.
//   payTo      /root/.config/agentfeed/gateway-seller.key's address: Gateway credits payTo's
//              Gateway balance and only that key can withdraw it (ops/gateway-withdraw.mjs).
//   routing    core picks one facilitator per (version, network, scheme), and Gateway's
//              scheme is `exact` like CDP's and Circle FS's, so those clients are wrapped:
//              a Gateway payment goes to Circle Gateway, everything else where it went before.
//   order      every Gateway accept comes after the chain's CDP/FS exact accept: Agent402
//              pays the first exact accept on a chain and cannot pay Gateway.
//
// PRICE: half the route's exact price, minimum $0.0005. Exact prices do not change.
// X402_HF=off removes both; a missing key file removes its tier.
'use strict';
const fs = require('fs');

const BATCH_NETWORKS = ['eip155:8453', 'eip155:137', 'eip155:42161'];
const GATEWAY_NETWORKS = ['eip155:5042']; // Arc only; see the header (R14, 18 Oct 2026)
const GATEWAY_WALLET = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE';
const GATEWAY_TIMEOUT_S = 604900; // Gateway requires validBefore >= 7 days ahead
const WITHDRAW_DELAY_S = 86400;   // claims run every 30 min; a day leaves 47 claim runs of margin
const KEY_DIR = '/root/.config/agentfeed';
const NAMES = { 'eip155:8453': 'Base', 'eip155:137': 'Polygon', 'eip155:42161': 'Arbitrum', 'eip155:5042': 'Arc' };

const hfUsd = (usd) => Math.round(Math.max(Number(usd) * 0.5, 0.0005) * 1e6) / 1e6;

function loadAccount(file) {
  const { privateKeyToAccount } = require('viem/accounts');
  return privateKeyToAccount(fs.readFileSync(file, 'utf8').trim());
}

function hfConfig(env = process.env) {
  if (env.X402_HF === 'off' || !env.PAY_TO_EVM) return { batch: null, gateway: null };
  const authKey = env.BATCH_AUTHORIZER_KEY || `${KEY_DIR}/batch-authorizer.key`;
  const gwKey = env.GATEWAY_SELLER_KEY || `${KEY_DIR}/gateway-seller.key`;
  return {
    batch: fs.existsSync(authKey) ? { networks: BATCH_NETWORKS, receiver: env.PAY_TO_EVM, authorizer: loadAccount(authKey) } : null,
    gateway: fs.existsSync(gwKey) ? { networks: GATEWAY_NETWORKS, payTo: loadAccount(gwKey).address } : null,
  };
}

/** One BatchSettlementEvmScheme per network, sharing the durable store. */
function batchSchemes(batch, db) {
  const { BatchSettlementEvmScheme } = require('@x402/evm/batch-settlement/server');
  const { createSqliteChannelStorage } = require('./batch-storage');
  return batch.networks.map((network) => ({
    network,
    scheme: new BatchSettlementEvmScheme(batch.receiver, {
      receiverAuthorizerSigner: { address: batch.authorizer.address, signTypedData: (p) => batch.authorizer.signTypedData(p) },
      withdrawDelay: WITHDRAW_DELAY_S,
      storage: createSqliteChannelStorage(db, { network }),
    }),
  }));
}

/** A facilitator client that sends Gateway payments to Circle Gateway and the rest to `inner`. */
function routeGateway(inner, gateway, isBatchPayment) {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'verify') return (p, r, ...rest) => (isBatchPayment(r) ? gateway.verify(p, r, ...rest) : target.verify(p, r, ...rest));
      if (prop === 'settle') return (p, r, ...rest) => (isBatchPayment(r) ? gateway.settle(p, r, ...rest) : target.settle(p, r, ...rest));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/** The accepts this tier adds to one route, after the route's exact accepts. */
function hfAccepts(cfg, usd) {
  const price = `$${hfUsd(usd)}`;
  const out = [];
  if (cfg.batch) for (const network of cfg.batch.networks) out.push({ scheme: 'batch-settlement', price, network, payTo: cfg.batch.receiver });
  if (cfg.gateway) for (const network of cfg.gateway.networks) {
    out.push({ scheme: 'exact', price, network, payTo: cfg.gateway.payTo, maxTimeoutSeconds: GATEWAY_TIMEOUT_S,
      extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: GATEWAY_WALLET } });
  }
  return out;
}

/** One sentence for the public surfaces; empty when the tier is off. */
function hfSentence(env = process.env) {
  const c = hfConfig(env);
  const parts = [];
  if (c.batch) parts.push(`batch-settlement (open a channel once, then off-chain vouchers) on ${c.batch.networks.map((n) => NAMES[n]).join(', ')}`);
  if (c.gateway) parts.push(`Circle Gateway nanopayments on ${c.gateway.networks.map((n) => NAMES[n]).join(', ')}`);
  return parts.length ? ` High-frequency callers pay half price (minimum $0.0005) through ${parts.join(' or ')}.` : '';
}

module.exports = { hfSentence, hfConfig, hfUsd, hfAccepts, batchSchemes, routeGateway, BATCH_NETWORKS, GATEWAY_NETWORKS, GATEWAY_WALLET, GATEWAY_TIMEOUT_S, WITHDRAW_DELAY_S, NAMES };
