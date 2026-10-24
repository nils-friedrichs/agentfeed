#!/usr/bin/env node
// bin/jito-tips-collect.js — Jito bundle tips sampled on-chain (R5 C4), for /api/jito-tips.
// Replaces Jito's tip_floor API, whose terms are unclear-leaning-banned (docs/SOURCES.md). No PM2:
//   */15 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/jito-tips.lock /usr/bin/timeout 180 /usr/bin/node --env-file=.env --max-old-space-size=192 bin/jito-tips-collect.js >> /opt/agentfeed/jito-tips.log 2>&1
//
// R20 (24 Oct 2026): this cron was the biggest burner of the free Helius plan: every 5 minutes, 8 getSignaturesForAddress plus about 70 getTransaction, roughly
// 20,000 calls a day since 12 Oct, which with the nuntius reads emptied the 1,000,000 credits on 23 Oct. It now leads with the FREE public mainnet RPC and
// keeps Helius as the fallback only (JITO_RPC_PRIMARY / JITO_RPC_FALLBACKS override), and runs every 15 minutes: about 8,400 public calls a day, none on Helius
// while the public RPC answers. One call at a time, 340 ms apart (about 3 a second), stays under the public RPC's 40 calls per method per 10 seconds.
// If neither endpoint can serve the sample (fewer than 40 tips) the run FAILS and writes nothing: the snapshot on disk gets older, the route says how old
// (age_s, as_of) and answers 503, not charged, once it passes MAX_AGE (lib/jito-age.js, 45 minutes). One `rpc_usage` line per run says which host served what.
// Per run: the newest PER_ACCOUNT signatures of each of the eight tip accounts, then each
// transaction; a tip is the lamports the tip account gained in it (the sweeps, where it loses
// lamports, are skipped). Percentiles of that sample go to jito-tips.json, written atomically.
'use strict';
const fs = require('fs');
const path = require('path');
const SR = require('../lib/solrpc');
const FO = require('../lib/rpc-failover.cjs');

const PER_ACCOUNT = 10;
// The RPC key is shared with the paid routes and the Seeker apps (6 req/s bucket in seeker-rpc).
// Measured 12 Oct: 6 parallel reads drew HTTP 429 on 68 of 144 calls and a paid route's call
// after them. So one request at a time, at most ~3 a second: about 30 s a run, ~0.3 req/s average.
const GAP_MS = process.env.JITO_GAP_MS !== undefined && Number.isFinite(Number(process.env.JITO_GAP_MS)) ? Number(process.env.JITO_GAP_MS) : 340;   // JITO_GAP_MS only for the tests: production keeps 340
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The free public RPC first, Helius (when configured) only as the fallback. Unset env: public first, SOLANA_RPC_URL / HELIUS_RPC / HELIUS_API_KEY behind it.
const EP = SR.makeEndpoints({
  name: 'jito-tips',
  primary: process.env.JITO_RPC_PRIMARY || FO.PUBLIC_MAINNET_RPC,
  fallbacks: process.env.JITO_RPC_FALLBACKS !== undefined ? FO.parseFallbacks(process.env.JITO_RPC_FALLBACKS) : [SR.RPC_URL()].filter(Boolean),
});
const OUT = process.env.JITO_TIPS_FILE || path.join(__dirname, '..', 'jito-tips.json');
const ACCOUNTS = require('../data/jito-tip-accounts.json').accounts;
const pctl = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];

async function run() {
  const t0 = Date.now();
  const pairs = [];
  for (const a of ACCOUNTS) {
    try { for (const s of (await SR.rpc('getSignaturesForAddress', [a, { limit: PER_ACCOUNT }], { endpoints: EP })) || []) if (!s.err) pairs.push([a, s.signature]); } catch { /* one account short */ }
    await sleep(GAP_MS);
  }
  if (!pairs.length) throw new Error('no tip-account signatures returned');
  const tips = []; let slotMin = Infinity, slotMax = 0, failed = 0;
  const get = async (sig) => {
    for (let a = 0; a < 2; a++) {
      try { const t = await SR.rpc('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], { endpoints: EP }); await sleep(GAP_MS); if (t && t.meta) return t; } catch { await sleep(GAP_MS * 3); }
    }
    return null;
  };
  for (const job of pairs) await one(job);
  async function one([acct, sig]) {
    const t = await get(sig);
    if (!t) { failed++; return; }
    const keys = [...t.transaction.message.accountKeys, ...((t.meta.loadedAddresses && [...t.meta.loadedAddresses.writable, ...t.meta.loadedAddresses.readonly]) || [])];
    const i = keys.indexOf(acct);
    if (i < 0) return;
    const gained = t.meta.postBalances[i] - t.meta.preBalances[i];
    if (gained > 0) { tips.push(gained / 1e9); slotMin = Math.min(slotMin, t.slot); slotMax = Math.max(slotMax, t.slot); }
  }
  if (tips.length < 40) throw new Error(`only ${tips.length} tips in the sample (${failed} reads failed)`);
  tips.sort((a, b) => a - b);
  const r = (x) => Number(x.toPrecision(6));
  const snap = {
    unit: 'SOL',
    percentiles: { p25: r(pctl(tips, 0.25)), p50: r(pctl(tips, 0.5)), p75: r(pctl(tips, 0.75)), p95: r(pctl(tips, 0.95)), p99: r(pctl(tips, 0.99)) },
    sample: { tips: tips.length, failed_reads: failed, slots: [slotMin, slotMax], accounts: ACCOUNTS.length },
    read: 'tip >= p75 to land bundles reliably in contested blocks',
    method: `the newest ${PER_ACCOUNT} transfers into each of Jito's ${ACCOUNTS.length} tip accounts, read from chain state; a tip is the lamports the tip account gained in that transaction`,
    source: 'Solana RPC: getSignaturesForAddress and getTransaction on the Jito tip accounts, percentiles computed by AgentFeed',
    refresh: 'every 15 minutes',
    as_of: new Date().toISOString(),
  };
  fs.writeFileSync(OUT + '.tmp', JSON.stringify(snap)); fs.renameSync(OUT + '.tmp', OUT);
  console.log(`${snap.as_of} jito-tips ok tips=${tips.length} failed=${failed} p50=${snap.percentiles.p50} p75=${snap.percentiles.p75} ${Date.now() - t0}ms rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}
run().catch((e) => { console.log(`${new Date().toISOString()} jito-tips FAILED ${String(e && e.message).slice(0, 200)}`); process.exitCode = 1; })
  .finally(() => EP.logUsage((l) => console.log(l)));
