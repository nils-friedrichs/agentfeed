#!/usr/bin/env node
// bin/peg-collect.js — one pass of the on-chain peg tape (R5 C3). No PM2 process:
//   */5 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/peg-collect.lock /usr/bin/timeout 120 /usr/bin/node --env-file=.env --max-old-space-size=192 bin/peg-collect.js >> /opt/agentfeed/peg-collect.log 2>&1
'use strict';
const t0 = Date.now();
require('../tools/pegonchain').collect().then((r) => {
  console.log(`${new Date().toISOString()} peg ok rows=${r.ok} errors=${r.errors.length}${r.errors.length ? ' ' + r.errors.join('; ').slice(0, 300) : ''} ${Date.now() - t0}ms rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
  if (!r.ok) process.exitCode = 1;
}).catch((e) => { console.log(`${new Date().toISOString()} peg FAILED ${String(e && e.message).slice(0, 200)} ${Date.now() - t0}ms`); process.exitCode = 1; });
