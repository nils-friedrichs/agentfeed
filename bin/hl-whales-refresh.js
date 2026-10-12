#!/usr/bin/env node
// bin/hl-whales-refresh.js — refresh the /api/hl-whales snapshot (R5 A6). No PM2 process:
//   */5 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/hl-whales.lock /usr/bin/timeout 120 /usr/bin/node --max-old-space-size=192 bin/hl-whales-refresh.js >> /opt/agentfeed/hl-whales.log 2>&1
'use strict';
const t0 = Date.now();
require('../tools/hlwhales').refreshToFile().then((s) => {
  console.log(`${new Date().toISOString()} hl-whales ok scanned=${s.scanned} with_positions=${s.withPositions} failed=${s.failed} positions=${s.positions.length} ${Date.now() - t0}ms rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
}).catch((e) => { console.log(`${new Date().toISOString()} hl-whales FAILED ${String(e && e.message).slice(0, 200)} ${Date.now() - t0}ms`); process.exitCode = 1; });
