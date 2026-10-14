// lib/ext-rails.js — R10 Phase A: the EVM networks added after the first thirteen accepts.
//
// ONE TABLE, read by payments.js (the 402 and the facilitator routing), lib/manifest.js, lib/rails.js (the text surfaces) and
// lib/compat.js (the suffix). Every row names its own facilitator; the routing in payments.js gives each facilitator client
// exactly its rows' networks and takes them away from every other client, so a payment on a new network can never reach CDP
// and a payment on an existing rail can never reach Ultravioleta or PayAI.
//
// TOKENS WERE READ ON-CHAIN on 2026-10-14, never typed from a brief: decimals(), symbol(), name(), version() or eip712Domain(),
// and the token's own DOMAIN_SEPARATOR() recomputed from (name, version, chainId, address) - it matched on every row, which is
// the proof the payer signs the domain below. EIP-3009 is present on every row (authorizationState answered). Addresses match
// the facilitator's /supported token list and, for USDC, Circle's published contract list. The price is an explicit
// {amount, asset, extra:{name, version}} for every row, so @x402/evm's DEFAULT_ASSETS (no entry for 10, 999, 130, 534352,
// 1187947933, 56, 4663, 480 or 196 in 2.28) never blocks a network.
//
// DEFAULT vs SUFFIX. The x402 v2 challenge travels in the PAYMENT-REQUIRED header; Node's clients (undici, fetch, axios) fail
// above 16,384 bytes of response headers, and R10 caps that header at 12,000 bytes. Measured through Cloudflare on 2026-10-14
// the largest route (trade-context) carried 10,916 bytes with today's thirteen accepts, and one EVM accept adds about 270, so
// three rows go in every 402 (`inDefault`): the three USDC networks with the most sellers in the CDP index on Oct 13
// (Optimism 1,705, Monad 919, Avalanche 692). Every other row is offered on request: GET /api/<route>|<network> (lib/compat.js
// stripNetworkSuffix) answers a 402 whose accepts are the default ones plus that network's, and a payment on any row is accepted
// on the plain URL too (payments.js reads the network the payer chose). test/r10a.test.js holds the 12,000-byte cap.
//
// minUsd: PayAI charges per settlement (Sei $0.00062 on Oct 13; X Layer had no published rate), so its rows appear only on
// routes priced at $0.005 or more.
'use strict';

const UV = 'ultravioleta';
const CDP = 'cdp';
const PAYAI = 'payai';
const FACILITATOR_URLS = { [UV]: 'https://facilitator.ultravioletadao.xyz', [PAYAI]: 'https://facilitator.payai.network' };

// network, name, facilitator, token {symbol, address, decimals, name, version} (name/version = the EIP-712 domain), inDefault, minUsd
const EXT_RAILS = [
  { network: 'eip155:10', name: 'Optimism', facilitator: UV, inDefault: true, token: { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, name: 'USD Coin', version: '2' } },
  { network: 'eip155:143', name: 'Monad', facilitator: UV, inDefault: true, token: { symbol: 'USDC', address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6, name: 'USDC', version: '2' } },
  { network: 'eip155:43114', name: 'Avalanche', facilitator: UV, inDefault: true, token: { symbol: 'USDC', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, name: 'USD Coin', version: '2' } },
  { network: 'eip155:42220', name: 'Celo', facilitator: UV, token: { symbol: 'USDC', address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, name: 'USDC', version: '2' } },
  { network: 'eip155:999', name: 'HyperEVM', facilitator: UV, token: { symbol: 'USDC', address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6, name: 'USDC', version: '2' } },
  { network: 'eip155:130', name: 'Unichain', facilitator: UV, token: { symbol: 'USDC', address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', decimals: 6, name: 'USDC', version: '2' } },
  { network: 'eip155:534352', name: 'Scroll', facilitator: UV, token: { symbol: 'USDC', address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', decimals: 6, name: 'USD Coin', version: '2' } },
  { network: 'eip155:1187947933', name: 'SKALE Base', facilitator: UV, token: { symbol: 'USDC.e', address: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20', decimals: 6, name: 'Bridged USDC (SKALE Bridge)', version: '2' } },
  // BNB Chain: the facilitator settles AUSD (Agora) there, not USDC; BNB's USDC is the Binance-Peg token, 18 decimals and no
  // EIP-3009 (authorizationState and version() revert), which no facilitator here settles. AUSD's EIP-712 domain is
  // "Agora Dollar" / "1" (eip712Domain()), not its name() "AUSD".
  { network: 'eip155:56', name: 'BNB Chain', facilitator: UV, token: { symbol: 'AUSD', address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', decimals: 6, name: 'Agora Dollar', version: '1' } },
  // Ethereum: Ultravioleta publishes no minimum, and POST /accepts kept a $0.001 requirement on Oct 14. Suffix-only: a settle
  // there costs the facilitator L1 gas, and the first proof payment is what shows it settles at that size.
  { network: 'eip155:1', name: 'Ethereum', facilitator: UV, token: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, name: 'USD Coin', version: '2' } },
  // Robinhood Chain: the facilitator settles USDG (Paxos Global Dollar); no version() or eip712Domain(), the domain
  // ("Global Dollar", "1") was found by matching its DOMAIN_SEPARATOR().
  { network: 'eip155:4663', name: 'Robinhood Chain', facilitator: UV, token: { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, name: 'Global Dollar', version: '1' } },
  // World Chain through CDP: CDP /supported listed exact on eip155:480 on Oct 14 (read on the box).
  { network: 'eip155:480', name: 'World Chain', facilitator: CDP, token: { symbol: 'USDC', address: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', decimals: 6, name: 'USDC', version: '2' } },
  { network: 'eip155:1329', name: 'Sei', facilitator: PAYAI, minUsd: 0.005, token: { symbol: 'USDC', address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392', decimals: 6, name: 'USDC', version: '2' } },
  { network: 'eip155:196', name: 'X Layer', facilitator: PAYAI, minUsd: 0.005, token: { symbol: 'USDC', address: '0xB6CEceAB302E2E4948951eE7843FC24E92933061', decimals: 6, name: 'USDC', version: '2' } },
];

/**
 * The rows live in this process. Off unless PAY_TO_EVM is set (the same treasury on every EVM chain). X402_EXT=off removes all
 * of them; X402_EXT_NETWORKS (comma-separated CAIP-2) narrows them; X402_PAYAI=off and X402_ULTRAVIOLETA=off remove one
 * facilitator's rows.
 */
function extRails(env = process.env) {
  if (!env.PAY_TO_EVM || env.X402_EXT === 'off') return [];
  const only = String(env.X402_EXT_NETWORKS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = only.filter((n) => !EXT_RAILS.some((r) => r.network === n));
  if (unknown.length) throw new Error(`X402_EXT_NETWORKS names unknown rails: ${unknown.join(', ')}`);
  return EXT_RAILS.filter((r) => (!only.length || only.includes(r.network))
    && !(r.facilitator === PAYAI && env.X402_PAYAI === 'off')
    && !(r.facilitator === UV && env.X402_ULTRAVIOLETA === 'off'));
}

/** The price an ext accept carries: always explicit, in the token's own units. */
function extPrice(rail, usd) {
  const t = rail.token;
  return { amount: String(Math.round(Number(usd) * 10 ** t.decimals)), asset: t.address, extra: { name: t.name, version: t.version } };
}

/** May this row appear on a route priced at usd? */
const extAllowed = (rail, usd) => !(rail.minUsd && Number(usd) < rail.minUsd);

/** The exact accept of one ext row for one route. */
function extAccept(rail, usd, payTo) {
  return { scheme: 'exact', price: extPrice(rail, usd), network: rail.network, payTo };
}

module.exports = { EXT_RAILS, extRails, extPrice, extAllowed, extAccept, FACILITATOR_URLS, UV, CDP, PAYAI };
