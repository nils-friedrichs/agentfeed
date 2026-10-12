#!/usr/bin/env node
// ops/batch-claim.js — claim and settle batch-settlement vouchers (R5 A1).
//
// The server verifies each voucher off-chain and records what it charged (agentfeed.db
// batch_channels, lib/batch-storage.js). This job redeems that charged total on-chain: per
// network, the channel manager claims every channel's latest voucher in one transaction
// through the CDP facilitator, then settles the claimed funds to the receiver (PAY_TO_EVM).
// The receiverAuthorizer key signs the claim authorization; it holds no funds.
//
// cron (root), every 30 min, under flock with a deadline, no PM2 process:
//   */30 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/batch-claim.lock /usr/bin/timeout 600 /usr/bin/node ops/batch-claim.js >> /opt/agentfeed/batch-claim.log 2>&1
// withdrawDelay is 86400 s (lib/hf.js), so a payer's timed withdrawal cannot finalize before
// 48 claim runs have passed.
//
// Every claim and settle transaction is appended to batch-claims.jsonl. Two failed runs in a
// row send one Telegram alert (liqbot bot, TG_ALERT_CHAT; values never printed).
//   --dry   list what is claimable per network; send nothing, write nothing
'use strict';
const fs = require('fs');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* env from the shell */ }
const Database = require('better-sqlite3');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { hfConfig, batchSchemes, NAMES } = require('../lib/hf');

const DRY = process.argv.includes('--dry');
const ROOT = path.join(__dirname, '..');
const LOG = process.env.BATCH_CLAIM_LOG || path.join(ROOT, 'batch-claims.jsonl');
const STATE = process.env.BATCH_CLAIM_STATE || path.join(ROOT, 'batch-claim-state.json');
const ENV_TG = '/opt/liqbot/.env';
const now = () => new Date().toISOString();

async function telegram(text) {
  try {
    const env = Object.fromEntries(fs.readFileSync(ENV_TG, 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
    if (!env.TG_BOT_TOKEN || !env.TG_ALERT_CHAT) return false;
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_ALERT_CHAT, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
    return (await r.json().catch(() => ({}))).ok === true;
  } catch { return false; }
}

(async () => {
  const cfg = hfConfig();
  if (!cfg.batch) { console.log(`${now()} batch-claim: batch-settlement is off (no authorizer key or X402_HF=off)`); return; }
  const db = new Database(process.env.AGENTFEED_DB || path.join(ROOT, 'agentfeed.db'));
  const facilitator = new HTTPFacilitatorClient(require('@coinbase/x402').facilitator);
  const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { failures: 0 }; } })();
  let failed = 0;
  for (const { network, scheme } of batchSchemes(cfg.batch, db)) {
    const name = NAMES[network] || network;
    try {
      const channels = await scheme.getStorage().list();
      const claimable = channels.filter((c) => BigInt(c.chargedCumulativeAmount) > BigInt(c.totalClaimed));
      const owed = claimable.reduce((a, c) => a + BigInt(c.chargedCumulativeAmount) - BigInt(c.totalClaimed), 0n);
      if (DRY) { console.log(`${now()} ${name}: ${channels.length} channels, ${claimable.length} claimable, ${Number(owed) / 1e6} USDC`); continue; }
      if (!claimable.length) continue;
      const mgr = scheme.createChannelManager(facilitator, network);
      const out = await mgr.claimAndSettle({ maxClaimsPerBatch: 100 });
      for (const c of out.claims) fs.appendFileSync(LOG, JSON.stringify({ at: now(), network, kind: 'claim', vouchers: c.vouchers, tx: c.transaction }) + '\n');
      if (out.settle) fs.appendFileSync(LOG, JSON.stringify({ at: now(), network, kind: 'settle', tx: out.settle.transaction, owed_usdc: Number(owed) / 1e6 }) + '\n');
      console.log(`${now()} ${name}: claimed ${out.claims.reduce((a, c) => a + c.vouchers, 0)} vouchers in ${out.claims.length} tx, settle ${out.settle ? out.settle.transaction : 'none'}, ${Number(owed) / 1e6} USDC`);
    } catch (e) {
      failed++;
      console.log(`${now()} ${name}: claim FAILED: ${String((e && e.message) || e).split('\n')[0].slice(0, 200)}`);
      fs.appendFileSync(LOG, JSON.stringify({ at: now(), network, kind: 'error', error: String((e && e.message) || e).slice(0, 300) }) + '\n');
    }
  }
  if (DRY) return;
  state.failures = failed ? (state.failures || 0) + 1 : 0;
  if (state.failures >= 2 && !state.alerted) {
    if (await telegram(`AgentFeed: batch-settlement claims failed ${state.failures} runs in a row; see /opt/agentfeed/batch-claim.log`)) state.alerted = true;
  }
  if (!state.failures) state.alerted = false;
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE + '.tmp', STATE);
})().catch((e) => { console.log(`${now()} batch-claim crashed: ${String(e && e.message).slice(0, 200)}`); process.exitCode = 1; });
