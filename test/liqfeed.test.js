// Task #90 (15 Oct 2026): /api/liq-feed, cross-venue liquidation pressure in 5-second buckets, computed by AgentFeed.
//   stream time  rows are placed by a clock that only moves forward, so a row that reaches the recording minutes after its event
//                (27% of one venue's rows, measured on the live tape) is counted in the bucket in which it arrived, not dropped
//   cursor       a property test over 4,000 events from three venues with realistic arrival delays: a poller advancing in random
//                steps and paging at 10 rows consumes every row exactly once (USD is conserved to the cent) and never sees a
//                bucket twice or out of order
//   shape        no exchange name, no venue column, no print count, 2/3 significant figures, dominant side, pressure
//   refusals     bad symbol, bad cursor, stale tape, a poll under 10 s: 400 / 429 / 503 and NO settlement, through the real x402
//                middleware and the prepaid-key rail
//   wiring       price, MCP tool, challenge title and question, description length, no exchange named in any text of the route
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// the tape the route reads, a temp file with the real schema; set BEFORE tools/liqdb.js reads LIQ_DB
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-liqfeed-'));
const DB_FILE = path.join(dir, 'liquidations.db');
process.env.LIQ_DB = DB_FILE;
const Database = require('better-sqlite3');
const SCHEMA = `CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
  size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit');
  CREATE INDEX idx_liq_sym_ts ON liquidations(symbol, ts); CREATE INDEX idx_liq_ex_ts ON liquidations(exchange, ts); CREATE INDEX idx_liq_ts ON liquidations(ts);`;
const w = new Database(DB_FILE);
w.pragma('journal_mode = WAL');
w.exec(SCHEMA);
const ins = w.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?, ?, ?, ?, ?, ?, ?)');
const put = (ts, symbol, side, size, price, exchange = 'bybit') => ins.run(ts, symbol, side, size, price, size * price, exchange);
test.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const LF = require('../tools/liqfeed');
const { BUCKET_MS, SETTLE_MS } = LF;

const ANCHOR = Math.floor((Date.now() - 3600_000) / BUCKET_MS) * BUCKET_MS;     // an hour ago, on a bucket boundary
const sig = (x, d) => (x !== 0 ? Number(Number(x).toPrecision(d)) : 0);
const BASE = new Map([['BTCUSDT', { median: 1_200_000 }], ['ETHUSDT', { median: 600_000 }], ['SOLUSDT', { median: 0 }]]);
const deps = (nowMs, extra = {}) => ({ now: () => nowMs, baseline: () => BASE, ...extra });
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** a small private tape for the scenario tests: rows are [ts, symbol, side, size, price, venue?] in ARRIVAL (id) order */
function miniTape(rowsIn) {
  const d = new Database(':memory:');
  d.exec(SCHEMA);
  const q = d.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [ts, symbol, side, size, price, ex] of rowsIn) q.run(ts, symbol, side, size, price, size * price, ex || 'bybit');
  return { add: (r) => q.run(r[0], r[1], r[2], r[3], r[4], r[3] * r[4], r[5] || 'bybit'), d: (nowMs, extra = {}) => ({ db: d, now: () => nowMs, baseline: () => BASE, tapeSymbol: (s) => s, ...extra }) };
}

// ---- fixture for the property test: events in time order, arrival (id) order = event time + a venue delay; one venue is often minutes late
const rnd = mulberry32(90);
const SYMS = [['BTCUSDT', 80000], ['ETHUSDT', 4000], ['SOLUSDT', 200], ['DOGEUSDT', 0.25]];
const EVENTS = [];
for (let i = 0; i < 4000; i++) {
  const [symbol, p0] = SYMS[Math.floor(rnd() * SYMS.length)];
  const ts = ANCHOR + i * 150 + Math.floor(rnd() * 80);
  const u = rnd();
  const venue = u < 0.25 ? 'bybit' : u < 0.8 ? 'binance' : 'okx';
  const delay = venue === 'bybit' ? 500 : venue === 'binance' ? 1200 : (rnd() < 0.27 ? 30_000 + Math.floor(rnd() * 570_000) : 1300);
  EVENTS.push({ ts, symbol, side: rnd() < 0.5 ? 'Buy' : 'Sell', price: p0 * (0.99 + rnd() * 0.02), size: (0.001 + rnd() * 5) * (1000 / p0 > 1 ? 1000 / p0 : 1), venue, arrive: ts + delay });
}
const ARRIVALS = [...EVENTS].sort((a, b) => a.arrive - b.arrive);
w.transaction(() => { for (const e of ARRIVALS) put(e.ts, e.symbol, e.side, e.size, e.price, e.venue); })();
let LATE = 0;
{ let mx = 0; for (const e of ARRIVALS) { if (mx && e.ts < mx - SETTLE_MS) LATE++; if (e.ts > mx) mx = e.ts; } }

test('fixture: the arrival process really has rows more than 10 s behind the stream (so the next test is not vacuous)', () => {
  assert.ok(LATE > 100, `${LATE} late rows of ${ARRIVALS.length}`);
});

test('stream time + cursor: a random-step poller paging at 10 rows consumes every row once (USD conserved), never repeats or reorders a bucket, and counts late rows', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];                           // DOGE is in the tape and must never appear
  const served = [];
  let next = null; let now = ANCHOR + 60_000; let calls = 0; let pages = 0;
  let lastF = 0; let lastId = 0;
  const step = mulberry32(7);
  const END = ANCHOR + 600_000 + 620_000 + 4 * BUCKET_MS + SETTLE_MS;          // past the last arrival
  let seenTail = false;
  while (calls < 3000) {
    const horizon = Math.floor((now - SETTLE_MS) / BUCKET_MS) * BUCKET_MS;
    const r = LF.getLiqFeed(next ? { symbols: 'BTC,ETH,SOL', next } : { symbols: 'BTC,ETH,SOL', since: ANCHOR }, undefined, deps(now, { maxRows: 10, scanCap: 150, unrounded: true }));
    calls++; if (r.has_more) pages++;
    assert.ok(r.buckets.length <= 10 + 2, `a page is whole buckets and stays near the cap, got ${r.buckets.length}`);
    for (const b of r.buckets) { assert.ok(b.t < horizon, 'only buckets older than the settle window'); assert.equal(b.t % BUCKET_MS, 0); }
    served.push(...r.buckets);
    const [F, id] = r.next.split('.').map(Number);
    assert.ok(F >= lastF && id >= lastId, 'the cursor never goes back');
    [lastF, lastId] = [F, id];
    next = r.next;
    if (!r.has_more) { if (now >= END) { seenTail = true; break; } now += 7_000 + Math.floor(step() * 33_000); }       // catch-up pages come at once; otherwise wait a random 7-40 s
  }
  assert.ok(seenTail, 'the poller reached the end of the tape');
  assert.ok(pages > 10, `pagination was exercised (${pages} pages)`);
  const maxId = w.prepare('SELECT MAX(id) m FROM liquidations').get().m;
  assert.equal(lastId, maxId, 'every row of the tape was consumed');
  const keys = served.map((b) => `${b.t}|${b.symbol}`);
  assert.equal(new Set(keys).size, keys.length, 'each (bucket, symbol) once, across all calls');
  const ts = served.map((b) => b.t);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts, 'buckets arrive in time order across the whole run');
  assert.ok(!served.some((b) => b.symbol === 'DOGEUSDT'));
  // conservation: the unrounded long+short USD of what was served equals the USD of the requested symbols' rows, to the cent
  for (const sym of symbols) {
    const want = w.prepare('SELECT SUM(usd) s, SUM(size) q FROM liquidations WHERE symbol = ?').get(sym);
    const got = served.filter((b) => b.symbol === sym).reduce((a, b) => ({ usd: a.usd + ((b.longs && b.longs.usd) || 0) + ((b.shorts && b.shorts.usd) || 0), qty: a.qty + ((b.longs && b.longs.qty) || 0) + ((b.shorts && b.shorts.qty) || 0) }), { usd: 0, qty: 0 });
    assert.ok(Math.abs(got.usd - want.s) < 0.01, `${sym}: USD ${got.usd} vs ${want.s}`);
    assert.ok(Math.abs(got.qty - want.q) < 1e-6 * Math.max(1, want.q), `${sym}: quantity`);
  }
});

test('stream time: a row that arrives minutes after its event is counted in the bucket where it arrived, and is not lost', () => {
  const T = ANCHOR + 4_000_000;                                                  // a quiet stretch of its own
  const m = miniTape([
    [T + 1000, 'BTCUSDT', 'Buy', 1, 80000],                                      // on time
    [T + 2000, 'BTCUSDT', 'Buy', 1, 80000, 'binance'],
    [T - 300_000, 'BTCUSDT', 'Sell', 2, 80000, 'okx'],                           // an event 5 minutes old, arriving now
    [T + 7000, 'ETHUSDT', 'Buy', 10, 4000],                                      // the clock moves into the next bucket
    [T + 12_000, 'ETHUSDT', 'Sell', 1, 4000],
  ]);
  const r = LF.getLiqFeed({ symbols: 'BTC,ETH', since: T }, undefined, m.d(T + 60_000, { unrounded: true }));
  const by = Object.fromEntries(r.buckets.map((b) => [`${b.t - T}|${b.symbol}`, b]));
  assert.equal(by['0|BTCUSDT'].longs.usd, 160000, 'the two on-time longs');
  assert.equal(by['0|BTCUSDT'].shorts.usd, 160000, 'the late short is counted in the bucket it arrived in, not 5 minutes back');
  assert.ok(!Object.keys(by).some((k) => Number(k.split('|')[0]) < 0), 'no bucket before the cursor floor');
  assert.equal(by['5000|ETHUSDT'].longs.usd, 40000);
  assert.equal(by['10000|ETHUSDT'].shorts.usd, 4000);
});

test('stream time: a row that arrives after a poll goes into a later bucket, never into one already served', () => {
  const T = ANCHOR + 4_100_000;
  const m = miniTape([[T + 1000, 'BTCUSDT', 'Buy', 1, 80000], [T + 6000, 'BTCUSDT', 'Buy', 1, 80000], [T + 11_000, 'BTCUSDT', 'Buy', 1, 80000]]);
  const a = LF.getLiqFeed({ symbols: 'BTC', since: T }, undefined, m.d(T + 30_000, { unrounded: true }));
  assert.deepEqual(a.buckets.map((b) => b.t - T), [0, 5000, 10000]);
  m.add([T + 2000, 'BTCUSDT', 'Sell', 3, 80000, 'okx']);                         // an old event reaches the recording after that poll
  const b = LF.getLiqFeed({ symbols: 'BTC', next: a.next }, undefined, m.d(T + 60_000, { unrounded: true }));
  assert.equal(b.count, 1);
  assert.ok(b.buckets[0].t >= Number(a.next.split('.')[0]), 'in a bucket at or after the cursor');
  assert.equal(b.buckets[0].shorts.usd, 240000);
  assert.equal(LF.getLiqFeed({ symbols: 'BTC', next: b.next }, undefined, m.d(T + 90_000)).count, 0, 'and never again');
});

test('cursor: a bucket is held back until it is 10 s old, then served once; an empty window advances; a cut page resumes with no gap', () => {
  const T = ANCHOR + 4_200_000;
  const m = miniTape([[T + 1000, 'BTCUSDT', 'Buy', 1, 80000], [T + 21_000, 'BTCUSDT', 'Sell', 1, 80000]]);
  const early = LF.getLiqFeed({ symbols: 'BTC', since: T }, undefined, m.d(T + 14_000));          // horizon = T+0: even the first bucket is only 9 s past its end
  assert.equal(early.count, 0);
  const a = LF.getLiqFeed({ symbols: 'BTC', since: T }, undefined, m.d(T + 20_000));              // horizon = T+10 s: bucket 0 is served, the row at T+21 s is in an open bucket
  assert.deepEqual(a.buckets.map((b) => b.t - T), [0]);
  assert.equal(a.has_more, false);
  assert.equal(LF.getLiqFeed({ symbols: 'BTC', next: a.next }, undefined, m.d(T + 21_000)).count, 0, 'the next bucket is still open');
  const b = LF.getLiqFeed({ symbols: 'BTC', next: a.next }, undefined, m.d(T + 40_000));
  assert.deepEqual(b.buckets.map((x) => [x.t - T, x.dominant]), [[20000, 'shorts']]);
  assert.equal(LF.getLiqFeed({ symbols: 'BTC', next: b.next }, undefined, m.d(T + 80_000)).count, 0, 'an empty window serves nothing and moves on');
  // a page cut at 1 row resumes exactly where it stopped
  const m2 = miniTape([[T + 1000, 'BTCUSDT', 'Buy', 1, 80000], [T + 6000, 'BTCUSDT', 'Buy', 2, 80000], [T + 11_000, 'BTCUSDT', 'Buy', 3, 80000]]);
  const p1 = LF.getLiqFeed({ symbols: 'BTC', since: T }, undefined, m2.d(T + 60_000, { maxRows: 1, unrounded: true }));
  assert.deepEqual([p1.has_more, p1.buckets.map((x) => x.longs.qty)], [true, [1]]);
  const p2 = LF.getLiqFeed({ symbols: 'BTC', next: p1.next }, undefined, m2.d(T + 60_001, { maxRows: 1, unrounded: true }));
  const p3 = LF.getLiqFeed({ symbols: 'BTC', next: p2.next }, undefined, m2.d(T + 60_002, { maxRows: 1, unrounded: true }));
  assert.deepEqual([p2.buckets.map((x) => x.longs.qty), p3.buckets.map((x) => x.longs.qty), p3.has_more], [[2], [3], false]);
});

test('cursor: with neither since nor next a call begins 2 minutes before the horizon', () => {
  const T = ANCHOR + 4_300_000;
  const m = miniTape([[T - 200_000, 'BTCUSDT', 'Buy', 1, 80000], [T - 100_000, 'BTCUSDT', 'Sell', 1, 80000], [T - 20_000, 'BTCUSDT', 'Buy', 1, 80000]]);
  const now = T + 5_000;
  const r = LF.getLiqFeed({ symbols: 'BTC' }, undefined, m.d(now));
  const horizon = Math.floor((now - SETTLE_MS) / BUCKET_MS) * BUCKET_MS;
  assert.equal(r.buckets.length, 2, JSON.stringify(r.buckets.map((b) => b.t - T)));        // the 200 s old row is outside the 2-minute window
  assert.ok(r.buckets.every((b) => b.t >= horizon - 120_000), 'nothing older than 2 minutes before the horizon');
  assert.equal(r.next.split('.')[0], String(horizon));
});

test('shape: no exchange name, no venue, no print count; rounded to 2 and 3 significant figures; dominant side; pressure', () => {
  const b0 = ANCHOR + 5_000_000;
  put(b0 + 1_200, 'BTCUSDT', 'Buy', 1.23456, 80123.4, 'binance');             // a lone print
  put(b0 + 6_100, 'ETHUSDT', 'Buy', 10, 4000, 'okx');
  put(b0 + 6_400, 'ETHUSDT', 'Sell', 7, 4000, 'bybit');
  put(b0 + 6_900, 'ETHUSDT', 'Sell', 3, 4000, 'binance');
  const r = LF.getLiqFeed({ symbols: 'BTC,ETH', since: b0 }, undefined, deps(b0 + 60_000));
  const btc = r.buckets.find((x) => x.symbol === 'BTCUSDT');
  assert.deepEqual(btc.longs, { usd: sig(1.23456 * 80123.4, 2), qty: 1.2, vwap: 80100 });
  assert.equal(btc.longs.usd, 99000);
  assert.deepEqual(Object.keys(btc), ['t', 'symbol', 'longs', 'shorts', 'dominant', 'pressure']);
  assert.equal(btc.dominant, 'longs');
  assert.equal(btc.pressure, sig(99_000 / (1_200_000 / 720), 2), 'pressure = bucket USD over the symbol\'s typical USD per 5 s');
  const eth = r.buckets.find((x) => x.symbol === 'ETHUSDT');
  assert.equal(eth.dominant, 'balanced', '40,000 long against 40,000 short');
  assert.deepEqual(eth.longs, { usd: 40000, qty: 10, vwap: 4000 });
  assert.deepEqual(eth.shorts, { usd: 40000, qty: 10, vwap: 4000 });
  const text = JSON.stringify(r);
  assert.ok(!/bybit|okx|binance/i.test(text), 'no exchange is named anywhere in the answer');
  for (const b of r.buckets) assert.ok(!('exchange' in b) && !('venues' in b) && !('prints' in b) && !('n' in b));
  assert.ok(!JSON.stringify(r.basis).match(/bybit|okx|binance/i));
});

test('shape: a symbol with no baseline entry is measured against the $5,000 an hour floor; a failed baseline gives pressure null, never an error', () => {
  const b0 = ANCHOR + 5_100_000;
  put(b0 + 500, 'DOGEUSDT', 'Buy', 4000, 0.25, 'bybit');                       // $1,000
  const r = LF.getLiqFeed({ symbols: 'DOGE', since: b0 }, undefined, deps(b0 + 60_000));
  assert.equal(r.buckets[0].pressure, sig(1000 / (5000 / 720), 2));
  const r2 = LF.getLiqFeed({ symbols: 'DOGE', since: b0 }, undefined, { now: () => b0 + 60_000, baseline: () => { throw new Error('baseline unavailable'); } });
  assert.equal(r2.buckets[0].pressure, null);
});

test('input: symbol forms resolve; bad input is a bad_request (400), never billed', () => {
  const now = ANCHOR + 700_000;
  const ok = (symbols) => LF.getLiqFeed({ symbols, since: ANCHOR + 590_000 }, undefined, deps(now)).symbols;
  assert.deepEqual(ok('btc-usdt, ETH ,sol/usdt,BTCUSDT'), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.deepEqual(LF.getLiqFeed({}, undefined, deps(now)).symbols, ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT'], 'the default is the 5-coin core set');
  const maxId = w.prepare('SELECT MAX(id) m FROM liquidations').get().m;
  const bad = (p, re) => assert.throws(() => LF.getLiqFeed(p, undefined, deps(now)), (e) => e.kind === 'bad_request' && re.test(e.message) && e.status === undefined, JSON.stringify(p));
  bad({ symbols: 'ZZZZUSDT' }, /unknown symbol/);
  bad({ symbols: 'BTC,ZZZZ' }, /unknown symbol/);
  bad({ symbols: 'BTC;DROP TABLE' }, /invalid symbol/);
  bad({ symbols: ',,' }, /empty/);
  bad({ symbols: Array.from({ length: 21 }, (_, i) => `A${i}`).join(',') }, /at most 20/);
  bad({ since: 'yesterday' }, /milliseconds/);
  bad({ since: String(now + 60_000) }, /future/);
  bad({ since: String(now - 25 * 3600_000) }, /24 h/);
  bad({ next: 'abc' }, /next/);
  bad({ next: String(ANCHOR) }, /next/);                                        // no ".id": not a cursor this route issued
  bad({ next: `${ANCHOR + 1}.5` }, /next/);                                     // not a bucket boundary
  bad({ next: `${now + 3600_000 - ((now + 3600_000) % BUCKET_MS)}.5` }, /future/);
  bad({ next: `${ANCHOR + 700_000}.${maxId + 1000}` }, /future or from another tape/);
  bad({ next: `${Math.floor((now - 25 * 3600_000) / BUCKET_MS) * BUCKET_MS}.5` }, /older than the 24 h/);
});

test('freshness: a tape older than 30 minutes is a 503 (never billed), exactly like the other tape routes', () => {
  assert.throws(() => LF.getLiqFeed({ symbols: 'BTC' }, undefined, deps(ANCHOR + 5_100_000 + 31 * 60_000)), (e) => e.status === 503 && /freshness bound/.test(e.message) && /Not charged/.test(e.message));
});

test('rate limit: one call per 10 s per key; catch-up pages (has_more) are exempt; MCP and different keys are not gated; x402 callers are keyed by IP', () => {
  LF._callers.clear();
  const reqKey = (prefix) => ({ keyPaid: { prefix }, callerIp: '1.1.1.1' });
  const now = ANCHOR + 700_000;
  const call = (req, at, extra) => LF.getLiqFeed({ symbols: 'BTC' }, req, deps(at, extra));
  call(reqKey('aaaaaaaa'), now);
  assert.throws(() => call(reqKey('aaaaaaaa'), now + 9_000), (e) => e.status === 429 && e.kind === 'bad_request' && e.retryAfter === 1 && /Not charged/.test(e.message));
  assert.throws(() => call(reqKey('aaaaaaaa'), now + 1_000), (e) => e.status === 429 && e.retryAfter === 9);
  call(reqKey('bbbbbbbb'), now + 1_000);                                      // another key
  call(undefined, now + 1_000); call(undefined, now + 1_001);                 // MCP: no gate here
  call(reqKey('aaaaaaaa'), now + 10_000);                                     // 10 s later: fine
  call({ callerIp: '2.2.2.2' }, now); assert.throws(() => call({ callerIp: '2.2.2.2' }, now + 5_000), (e) => e.status === 429);
  call({ callerIp: '3.3.3.3' }, now + 5_000);                                 // a different IP
  // catch-up: while the answer says has_more the next page is immediate
  LF._callers.clear();
  const big = (at) => LF.getLiqFeed({ symbols: 'BTC,ETH,SOL', since: ANCHOR }, reqKey('cccccccc'), deps(at, { maxRows: 10 }));
  const a = big(ANCHOR + 700_000); assert.equal(a.has_more, true);
  const b = LF.getLiqFeed({ symbols: 'BTC,ETH,SOL', next: a.next }, reqKey('cccccccc'), deps(ANCHOR + 700_001, { maxRows: 10 }));   // 1 ms later, allowed
  assert.equal(b.buckets.length > 0, true);
});

// R15d: over MCP a pass key is on the clock its REST calls use. mcp.js hands get_liq_feed { passGateKey: 'key:<prefix>' } (lib/keys.js passGateKey).
test('R15d rate limit: a pass key has ONE clock across REST and MCP (has_more included); MCP without a pass key is still ungated', () => {
  LF._callers.clear();
  const rest = (prefix) => ({ keyPaid: { prefix }, callerIp: '1.1.1.1' });
  const mcp = (prefix) => ({ passGateKey: `key:${prefix}` });
  const now = ANCHOR + 700_000;
  const call = (req, at, extra) => LF.getLiqFeed({ symbols: 'BTC' }, req, deps(at, extra));
  assert.equal(LF._callerKey(rest('aaaaaaaa')), LF._callerKey(mcp('aaaaaaaa')), 'the same key string on both surfaces');
  call(rest('aaaaaaaa'), now);                                                // REST first ...
  assert.throws(() => call(mcp('aaaaaaaa'), now + 3_000), (e) => e.status === 429 && e.kind === 'bad_request' && e.retryAfter === 7 && /Not charged/.test(e.message), '... MCP 3 s later is refused');
  call(mcp('bbbbbbbb'), now + 3_000);                                         // another key is its own clock
  call(mcp('aaaaaaaa'), now + 10_000);                                        // 10 s after the REST call: admitted ...
  assert.throws(() => call(rest('aaaaaaaa'), now + 12_000), (e) => e.status === 429 && e.retryAfter === 8, '... and REST is now refused after the MCP call');
  call(undefined, now + 12_000); call(undefined, now + 12_001);               // MCP without a pass key (x402, a pack): no gate here, as before
  call(mcp('aaaaaaaa'), now + 20_000);
  // catch-up crosses the surfaces too: a REST answer that says has_more lets the next MCP page through at once
  LF._callers.clear();
  const a = LF.getLiqFeed({ symbols: 'BTC,ETH,SOL', since: ANCHOR }, rest('cccccccc'), deps(ANCHOR + 700_000, { maxRows: 10 }));
  assert.equal(a.has_more, true);
  const b = LF.getLiqFeed({ symbols: 'BTC,ETH,SOL', next: a.next }, mcp('cccccccc'), deps(ANCHOR + 700_001, { maxRows: 10 }));
  assert.equal(b.buckets.length > 0, true);
  if (!b.has_more) assert.throws(() => LF.getLiqFeed({ symbols: 'BTC,ETH,SOL', next: b.next }, rest('cccccccc'), deps(ANCHOR + 700_002, { maxRows: 10 })), (e) => e.status === 429, 'the last page ends the catch-up');
});

// ---- through the real x402 middleware and the key rail: refusals settle nothing
const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { makeKeys } = require('../lib/keys');
const { makeTool } = require('../lib/tool');
const { hfUsd } = require('../lib/hf');
const NET = 'eip155:8453';
const PAYTO = '0x' + '22'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));
const PRICES = { 'GET /api/liq-feed': { usd: 0.001, tool: 'get_liq_feed' } };

async function boot(clock) {
  const kdb = new Database(':memory:');
  const rows = [];
  const logCall = (r) => rows.push(r);
  const fac = { calls: { verify: 0, settle: 0 },
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { this.calls.verify++; return { isValid: true, payer: PAYER }; },
    async settle() { this.calls.settle++; return { success: true, transaction: '0x' + '5e'.repeat(32), network: NET, payer: PAYER }; } };
  const rs = new x402ResourceServer([fac]).register(NET, new ExactEvmScheme());
  const gate = paymentMiddleware({ 'GET /api/liq-feed': { accepts: [{ scheme: 'exact', price: '$0.001', network: NET, payTo: PAYTO }], description: 'get_liq_feed', mimeType: 'application/json' } }, rs);
  const K = makeKeys({ db: kdb, PRICES, logCall, hfUsd, paymentsOn: true });
  const app = express();
  let ip = '10.0.0.1';
  app.use((req, _res, next) => { req.callerIp = ip; next(); });
  app.use(K.identify); app.use(K.purchaseGuard); app.use(K.charge);
  app.use((req, res, next) => { if (req.keyPaid) return next(); return gate(req, res, next); });
  const { tool } = makeTool({ paymentsOn: true, PRICES, decodeSettlement: (res) => { const raw = res.getHeader('payment-response'); return raw ? unb64(raw) : null; }, logCall });
  app.get('/api/liq-feed', tool('get_liq_feed', 0.001, (req) => LF.getLiqFeed(req.query, req, deps(clock.t))));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  async function pay(p, headers = {}) {
    const ch = await get(p, headers);
    if (ch.status !== 402) return ch;
    const pr = unb64(ch.headers.get('payment-required'));
    const sig2 = b64({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAYTO, value: pr.accepts[0].amount, validAfter: '0', validBefore: String(2 ** 40), nonce: '0x' + '00'.repeat(32) } } });
    return get(p, { ...headers, 'payment-signature': sig2 });
  }
  await new Promise((r) => setTimeout(r, 30));
  return { rows, fac, K, get, pay, setIp: (v) => { ip = v; }, close: () => { K.stop(); server.close(); } };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

test('x402: a good call settles once at $0.001; a bad symbol (400), a poll under 10 s (429 + Retry-After) and a stale tape (503) settle nothing', async (t) => {
  LF._callers.clear();
  const clock = { t: ANCHOR + 700_000 };
  const s = await boot(clock); t.after(s.close);
  const ok = await s.pay('/api/liq-feed?symbols=BTC,ETH&since=' + (ANCHOR + 590_000));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.tool, 'get_liq_feed');
  assert.ok(Array.isArray(body.data.buckets) && /^\d+\.\d+$/.test(body.data.next));
  assert.equal(s.fac.calls.settle, 1);
  const tooSoon = await s.pay('/api/liq-feed?symbols=BTC&next=' + body.data.next);
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.headers.get('retry-after'), '10');
  assert.match((await tooSoon.json()).error, /one call every 10 s/);
  assert.equal(s.fac.calls.settle, 1, 'the 429 settled nothing');
  clock.t += 20_000;
  const unk = await s.pay('/api/liq-feed?symbols=ZZZZUSDT');
  assert.equal(unk.status, 400);
  assert.match((await unk.json()).error, /unknown symbol/);
  assert.equal(s.fac.calls.settle, 1, 'the 400 settled nothing');
  clock.t = ANCHOR + 5_100_000 + 31 * 60_000;
  s.setIp('10.0.0.2');
  const stale = await s.pay('/api/liq-feed?symbols=BTC');
  assert.equal(stale.status, 503);
  assert.equal(s.fac.calls.settle, 1, 'the 503 settled nothing');
  await flush();
  assert.deepEqual(s.rows.filter((r) => r.status === 'paid').map((r) => [r.tool, r.amount_usdc, r.req_path]), [['get_liq_feed', 0.001, '/api/liq-feed']]);
});

test('key rail: $0.0005 a call; every refusal refunds the reservation in full and writes no key row', async (t) => {
  LF._callers.clear();
  const clock = { t: ANCHOR + 700_000 };
  const s = await boot(clock); t.after(s.close);
  const k = s.K.store.grant(0.01, 'liqfeed');
  const bal = () => s.K.store.get(require('../lib/keys').hashKey(k)).balance_micro;
  assert.equal(bal(), 10_000);
  assert.equal((await s.get('/api/liq-feed?symbols=BTC&since=' + (ANCHOR + 590_000), { 'x-agentfeed-key': k })).status, 200);
  assert.equal(bal(), 10_000 - 500, 'half of $0.001');
  const r429 = await s.get('/api/liq-feed?symbols=BTC', { 'x-agentfeed-key': k });
  assert.equal(r429.status, 429);
  assert.equal(r429.headers.get('retry-after'), '10');
  assert.equal(bal(), 10_000 - 500, 'a 429 is refunded');
  clock.t += 20_000;
  assert.equal((await s.get('/api/liq-feed?symbols=NOPEUSDT', { 'x-agentfeed-key': k })).status, 400);
  assert.equal(bal(), 10_000 - 500, 'a 400 is refunded');
  await flush();
  assert.equal(s.rows.filter((r) => r.status === 'key').length, 1);
  assert.equal(s.rows.filter((r) => r.status === 'key')[0].amount_usdc, 0.0005);
});

// ---- wiring: price, MCP tool, challenge, text
test('wiring: priced at the $0.001 floor, an MCP tool, a title and a question, a description that fits, and no exchange named anywhere', () => {
  const { PRICES_ADD, MCP_DEFS_ADD, EXP, TAGS_ADD } = require('../expansion');
  const p = PRICES_ADD['GET /api/liq-feed'];
  assert.equal(p.usd, 0.001);
  assert.equal(p.tool, 'get_liq_feed');
  assert.equal(hfUsd(p.usd), 0.0005);
  const mcp = MCP_DEFS_ADD.find((d) => d.name === 'get_liq_feed');
  assert.ok(mcp && mcp.usd === 0.001);
  const { TOOL_TITLES } = require('../tools/titles');
  const { QUESTIONS } = require('../tools/questions');
  assert.equal(TOOL_TITLES.get_liq_feed, 'Liquidation pressure feed');
  assert.match(QUESTIONS.get_liq_feed, /liquidated/);
  assert.ok(p.desc.length >= 180 && p.desc.length <= 255, `description ${p.desc.length} chars`);
  assert.ok(/^Use when /.test(p.desc));
  const def = EXP.find((t) => t.name === 'get_liq_feed');
  const everyText = [p.desc, TOOL_TITLES.get_liq_feed, QUESTIONS.get_liq_feed, ...(TAGS_ADD.get_liq_feed || []), ...Object.values(def.schema).map((z) => z.description || '')].join('\n');
  assert.ok(!/bybit|okx|binance/i.test(everyText), 'no exchange is named in the route text');
  assert.ok(!(TAGS_ADD.get_liq_feed || []).some((x) => /bybit|okx|binance|exchange/i.test(x)));
  const { challengeDesc, challengeLead, CHALLENGE_DESC_MAX } = require('../payments');
  const d = challengeDesc(challengeLead(PRICES_ADD['GET /api/liq-feed']));
  assert.ok(d.length <= CHALLENGE_DESC_MAX && /Use when you need to answer: /.test(d), 'the 402 description keeps its question');
  assert.ok(d.startsWith('Liquidation pressure feed: '));
});
