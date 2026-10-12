#!/usr/bin/env node
// ops/arc-reconcile.js — settle the record on Arc payments Circle left pending (R4, 2026-10-12).
//
// lib/circle-arc.js withholds the response when /settle stays settlement_pending after its
// in-request polls, and appends the paymentId to arc-pending.jsonl. Run this by hand (it is
// not a cron and never runs on its own):
//   cd /opt/agentfeed && node ops/arc-reconcile.js
// For each entry it asks GET /status/{paymentId} (same auth as the service: CIRCLE_API_KEY
// from .env, else a seller proof from the Arc payTo key) and prints pending / completed /
// failed. A `completed` row is a buyer who paid and got no data: refund it from the Arc
// payTo, or credit them. Resolved rows move to arc-pending.done.jsonl; pending ones stay.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* env from the shell */ }
const { CircleArcFacilitator } = require('../lib/circle-arc');

(async () => {
  const c = new CircleArcFacilitator();
  const file = c.pendingLog;
  if (!fs.existsSync(file)) { console.log(`no pending Arc payments (${file} absent)`); return; }
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const keep = []; const done = [];
  for (const r of rows) {
    try {
      const s = await c.status(r.paymentId);
      console.log(`${r.at} ${r.paymentId} ${s.status}${s.transaction ? ` tx ${s.transaction}` : ''} payer ${s.payer || r.payer} amount ${s.amount || r.amount} ${r.resource || ''}`);
      if (s.status === 'pending') keep.push(r); else done.push({ ...r, status: s.status, transaction: s.transaction || null, checked: new Date().toISOString() });
    } catch (e) {
      console.log(`${r.paymentId} status lookup failed: ${e.message}`);
      keep.push(r);
    }
  }
  if (done.length) fs.appendFileSync(file.replace(/\.jsonl$/, '.done.jsonl'), done.map((d) => JSON.stringify(d)).join('\n') + '\n');
  fs.writeFileSync(file, keep.map((k) => JSON.stringify(k)).join('\n') + (keep.length ? '\n' : ''));
  console.log(`${rows.length} checked: ${done.filter((d) => d.status === 'completed').length} completed (paid, undelivered: refund), ${done.filter((d) => d.status === 'failed').length} failed, ${keep.length} still pending`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
