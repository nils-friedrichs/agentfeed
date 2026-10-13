// tools/solana2.js — expansion: Solana suite (5 tools).
// Standard Solana JSON-RPC only since R5 C4 (lib/solrpc.js): no DAS, no enhanced transactions
// API, no getPriorityFeeEstimate, no Jito tip_floor. Jito tips are sampled on-chain by root cron
// (bin/jito-tips-collect.js) into jito-tips.json. Everything cached; RPC credits are metered.
'use strict';
const { cached, fetchJson } = require('../lib/cache');
const SR = require('../lib/solrpc');

const HELIUS_RPC = () => process.env.HELIUS_RPC || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
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

async function rpc(method, params) {
  const j = await fetchJson(HELIUS_RPC(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'agentfeed', method, params }),
    timeoutMs: 10_000,
  });
  if (j.error) {
    const e = new Error(`helius rpc: ${j.error.message}`);
    // A mint whose holder set is too large to enumerate is the CALLER naming
    // something the upstream cannot answer for, not a fault here. Same class as
    // an exchange's parameter error on an HTTP 200 (once handled in derivs/micro/positioning), and tagged at the shared
    // helper for the same reason those are. Without this the three most obvious
    // mints anyone would try - SOL, USDC, BONK - return 502 from
    // /telegraph/api/token-holders, and telegraph's validator FAILS an endpoint
    // on 5xx while passing a 4xx, so a registered route reads as dead.
    //
    // Matched on BOTH the JSON-RPC code and the wording, deliberately narrow:
    // -32600 is the generic "Invalid Request" and Helius reuses it, so matching
    // the code alone would blame the caller for unrelated upstream failures.
    if (j.error.code === -32600 && /too many accounts/i.test(j.error.message || '')) {
      e.badRequest = true;
    }
    throw e;
  }
  return j.result;
}

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
    const txs = await Promise.all((sigs || []).map((s) => SR.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null)));
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
// bin/jito-tips-collect.js (root cron, every 5 minutes) reads the newest transfers into Jito's
// eight tip accounts and writes their percentiles; a snapshot over 12 minutes old is a 503.
const JITO_SNAPSHOT = () => process.env.JITO_TIPS_FILE || path.join(__dirname, '..', 'jito-tips.json');
async function getJitoTips() {
  let s;
  try { s = JSON.parse(fs.readFileSync(JITO_SNAPSHOT(), 'utf8')); } catch { throw SR.unavailable('Jito tip sample not built yet. Not charged.'); }
  const age = Math.round((Date.now() - Date.parse(s.as_of)) / 1000);
  if (!(age <= 12 * 60)) throw SR.unavailable(`Jito tip sample is ${age}s old (limit 720s). Not charged.`);
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
