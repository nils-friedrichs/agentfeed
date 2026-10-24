// tools/solana2.js — expansion: Solana suite (5 tools).
// Standard Solana JSON-RPC only since R5 C4 (lib/solrpc.js): no DAS, no enhanced transactions
// API, no getPriorityFeeEstimate, no Jito tip_floor. Jito tips are sampled on-chain by root cron
// (bin/jito-tips-collect.js) into jito-tips.json. Everything cached; RPC credits are metered.
'use strict';
const { cached } = require('../lib/cache');
const SR = require('../lib/solrpc');
const JITO_AGE = require('../lib/jito-age');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Mints whose holder set Helius will not rank: getTokenLargestAccounts answers "Too many
// accounts requested (10000000 pubkeys)". Refused with a 400 BEFORE any upstream call (a
// status of 400 or more never settles, so nobody is charged). Seeded with wSOL, USDC and
// USDT; any mint that fails that way at runtime is added and kept in large-mints.json.
const fs = require('fs');
const path = require('path');
const LARGE_MINTS_FILE = process.env.LARGE_MINTS_FILE || path.join(__dirname, '..', 'large-mints.json');
const LARGE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
try { for (const m of JSON.parse(fs.readFileSync(LARGE_MINTS_FILE, 'utf8'))) if (BASE58_RE.test(m)) LARGE_MINTS.add(m); } catch { /* no file yet */ }
function tooLarge(mint) {
  const e = new Error(`token-holders: ${mint} has too many token accounts to rank. The RPC node's getTokenLargestAccounts refuses mints above its 10,000,000-account limit (wSOL, USDC and USDT among them), so no holder concentration is available for this mint. Not charged.`);
  e.kind = 'bad_request'; e.badRequest = true;
  return e;
}
function rememberLarge(mint) {
  if (LARGE_MINTS.has(mint)) return;
  LARGE_MINTS.add(mint);
  try { fs.writeFileSync(LARGE_MINTS_FILE + '.tmp', JSON.stringify([...LARGE_MINTS], null, 1)); fs.renameSync(LARGE_MINTS_FILE + '.tmp', LARGE_MINTS_FILE); } catch { /* kept in memory */ }
}

// Every Solana read goes through lib/solrpc (the failover endpoint list, R20): a JSON-RPC error object throws an error tagged badRequest for a mint
// whose holder set is too large to enumerate (the CALLER named something the node cannot answer, not a fault here: without that tag the three most
// obvious mints, SOL, USDC and BONK, returned 502 from /telegraph/api/token-holders and telegraph's validator FAILS an endpoint on 5xx while passing a
// 4xx). It is matched on BOTH the JSON-RPC code and the wording (-32600 is the generic "Invalid Request" and Helius reuses it). When no endpoint
// answers (rate limited, out of credits, down) the call throws a 503 and x402 does not settle.
const rpc = SR.rpc;

// ---- get_token_holders ($0.02) — top holders + concentration metrics
async function getTokenHolders(p = {}) {
  const mint = p.mint;
  // A malformed or absent mint is the caller's input, so it is a 400 like the
  // too-many-accounts case above. server.js tool() already answers 400 for any
  // throw, so this changes nothing on the paid rail; it exists for telegraph's
  // statusFor(), which otherwise reads an untagged throw as 502 and fails a
  // healthy registered endpoint when a validator probes it with no argument.
  if (!BASE58_RE.test(mint || '')) { const e = new Error('invalid mint address'); e.badRequest = true; throw e; }
  if (LARGE_MINTS.has(mint)) throw tooLarge(mint);
  return cached(`holders:${mint}`, 60_000, async () => {
    const [mi, largest] = await Promise.all([
      SR.mintInfo(mint),
      rpc('getTokenLargestAccounts', [mint]).catch((e) => {
        if (e.badRequest && /too many accounts/i.test(e.message)) { rememberLarge(mint); throw tooLarge(mint); }
        throw e;
      }),
    ]);
    const supply = mi.supply;
    const accounts = (largest?.value || []).map((a) => ({
      address: a.address,
      amount: parseFloat(a.uiAmountString ?? a.uiAmount ?? 0),
    }));
    const pctOf = (k) => (supply ? Number(((accounts.slice(0, k).reduce((s, a) => s + a.amount, 0) / supply) * 100).toFixed(2)) : null);
    return {
      mint, symbol: (mi.metadata && mi.metadata.symbol) || null, supply,
      top_accounts: accounts.map((a) => ({ ...a, pct: supply ? Number(((a.amount / supply) * 100).toFixed(2)) : null })),
      concentration: { top1_pct: pctOf(1), top5_pct: pctOf(5), top10_pct: pctOf(10) },
      note: 'token accounts, not unique owners — pools and exchanges included. Fails for mega-holder tokens (USDC-scale).',
      source: 'Solana RPC: getTokenLargestAccounts and the mint account',
    };
  });
}

// ---- get_wallet_activity ($0.02) — recent transactions, read and summarised by us
// getSignaturesForAddress then getTransaction per signature (jsonParsed). Each row: what the
// wallet's SOL and token balances did, the fee, success, and the programs invoked (named where
// the id is one we verified). No third-party parsing.
async function getWalletActivity(p = {}) {
  const wallet = p.wallet;
  if (!BASE58_RE.test(wallet || '')) { const e = new Error('invalid wallet address'); e.badRequest = true; e.kind = 'bad_request'; throw e; }
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  return cached(`activity:${wallet}:${limit}`, 30_000, async () => {
    const sigs = await SR.rpc('getSignaturesForAddress', [wallet, { limit }]);
    const txs = await Promise.all((sigs || []).map((s) => SR.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
      // a pruned or unreadable transaction is skipped; no endpoint answering at all is an outage, and an outage is not "this wallet has fewer transactions"
      .catch((e) => { if (e.transport) throw e; return null; })));
    const rows = txs.filter(Boolean).map((t) => SR.summarizeTx(t, wallet));
    return {
      wallet, tx_count: rows.length, transactions: rows,
      source: 'Solana RPC: getSignaturesForAddress and getTransaction, summarised by AgentFeed',
    };
  });
}

// ---- get_priority_fees ($0.005) — what to tip the network right now
// getRecentPrioritizationFees over the two busiest SOL/USDC pools (tools/dexspot.js): for each of
// the last ~150 slots, the lowest priority fee among the transactions that wrote to them. The
// levels are percentiles of those per-slot minimums, computed here.
const FEE_ACCOUNTS = ['Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv'];
const pctl = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
async function getPriorityFees() {
  return cached('priofees', 10_000, async () => {
    const r = await SR.rpc('getRecentPrioritizationFees', [FEE_ACCOUNTS]);
    const v = (r || []).map((x) => x.prioritizationFee).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) throw SR.unavailable('no recent prioritization fees returned');
    return {
      unit: 'micro-lamports per compute unit',
      levels: { min: v[0], low: pctl(v, 0.25), medium: pctl(v, 0.5), high: pctl(v, 0.75), very_high: pctl(v, 0.95), unsafe_max: v[v.length - 1] },
      recommended: pctl(v, 0.75),
      slots: v.length,
      method: 'percentiles of the per-slot minimum priority fee paid by transactions that wrote to the two busiest SOL/USDC pools, over the last ~150 slots',
      source: 'Solana RPC getRecentPrioritizationFees, percentiles computed by AgentFeed',
    };
  });
}

// ---- get_jito_tips ($0.005) — Jito bundle tips, sampled on-chain
// bin/jito-tips-collect.js (root cron, every 15 minutes since R20, from the free public RPC) reads the newest transfers into Jito's
// eight tip accounts and writes their percentiles. The answer carries age_s and as_of; a snapshot over 45 minutes old (three missed runs) is a 503, not charged.
const JITO_SNAPSHOT = () => process.env.JITO_TIPS_FILE || path.join(__dirname, '..', 'jito-tips.json');
async function getJitoTips() {
  let s;
  try { s = JSON.parse(fs.readFileSync(JITO_SNAPSHOT(), 'utf8')); } catch { throw SR.unavailable('Jito tip sample not built yet. Not charged.'); }
  const age = Math.round((Date.now() - Date.parse(s.as_of)) / 1000);
  const limit = JITO_AGE.MAX_AGE_S();
  if (!(age <= limit)) throw SR.unavailable(`Jito tip sample is ${age}s old (limit ${limit}s; it is rebuilt every ${JITO_AGE.REFRESH_S / 60} minutes and its last run could not read enough tips). Not charged.`);
  return { ...s, age_s: age };
}

// ---- get_sol_network ($0.005) — chain health: TPS + slot + epoch progress
async function getSolNetwork() {
  return cached('solnet', 15_000, async () => {
    const [perf, epoch] = await Promise.all([
      SR.rpc('getRecentPerformanceSamples', [4]),
      SR.rpc('getEpochInfo', []),
    ]);
    const tps = perf?.length
      ? perf.map((s) => s.numTransactions / s.samplePeriodSecs)
      : [];
    const avg = tps.length ? Math.round(tps.reduce((a, b) => a + b, 0) / tps.length) : null;
    return {
      tps_avg_recent: avg,
      slot: epoch?.absoluteSlot ?? null,
      epoch: epoch?.epoch ?? null,
      epoch_progress_pct: epoch?.slotsInEpoch ? Number(((epoch.slotIndex / epoch.slotsInEpoch) * 100).toFixed(1)) : null,
      source: 'Solana RPC: getRecentPerformanceSamples and getEpochInfo',
    };
  });
}

module.exports = { _LARGE_MINTS: LARGE_MINTS, getTokenHolders, getWalletActivity, getPriorityFees, getJitoTips, getSolNetwork };
