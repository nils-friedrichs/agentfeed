#!/usr/bin/env node
// bin/hl-oi-collect.js — the Hyperliquid open-interest sampler (R7 R1c): one metaAndAssetCtxs call, every coin's OI stored,
// 7 days kept in hl-oi.db (lib/hl-oi.js). cron, every 5 minutes, under flock and timeout, small heap:
//   */5 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/hl-oi.lock /usr/bin/timeout 90 /usr/bin/node --max-old-space-size=192 bin/hl-oi-collect.js >> /opt/agentfeed/hl-oi.log 2>&1
// Silent on success (the watchdog reads the newest row); a failure prints one line and exits 1.
'use strict';
const store = require('../lib/hl-oi');

const API = process.env.HL_API || 'https://api.hyperliquid.xyz/info';

(async () => {
  const ts = Math.floor(Date.now() / 1000);
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  const rows = store.rowsFrom(await r.json(), ts);
  if (rows.length < 50) throw new Error(`only ${rows.length} coins in the answer, refusing to store a partial sample`);
  const db = store.openRw();
  const s = store.record(db, rows, ts);
  db.close();
  if (process.env.HL_OI_VERBOSE) console.log(new Date().toISOString(), 'ok', JSON.stringify(s));
})().catch((e) => { console.log(new Date().toISOString(), 'FAILED', String(e && e.message || e).slice(0, 200)); process.exit(1); });
