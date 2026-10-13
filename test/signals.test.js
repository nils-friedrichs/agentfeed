// R9 K3: /api/signal-board and /api/coin-signal/:coin over synthetic copies of the three box sources
// (hl-oi.db, the liquidation tape, hl-whales.json). Shape for NOFX's data_path, size bounds, the flag rules,
// staleness = 503, unknown coin = 400.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-signals-'));
process.env.HL_OI_DB = path.join(dir, 'hl-oi.db');
process.env.LIQ_DB = path.join(dir, 'liq.db');
process.env.HL_WHALES_SNAPSHOT = path.join(dir, 'hl-whales.json');

const NOW = Date.UTC(2026, 9, 14, 12, 2, 0); // 14 Oct 2026 12:02Z
const NOW_S = Math.floor(NOW / 1000);
const H = 3600;

// 60 coins: C00 has the largest OI. Samples every 5 min for 25 h, newest 2 min before NOW.
const coins = Array.from({ length: 60 }, (_, i) => `C${String(i).padStart(2, '0')}`);
coins.push('kPEPE', 'HOT');
function buildOi({ newestAgoS = 120, hours = 25 } = {}) {
  try { fs.unlinkSync(process.env.HL_OI_DB); } catch { /* none */ }
  const db = new Database(process.env.HL_OI_DB);
  db.exec('CREATE TABLE hl_oi (coin TEXT NOT NULL, ts INTEGER NOT NULL, oi REAL NOT NULL, mark REAL, funding REAL, vol24 REAL, PRIMARY KEY (coin, ts)) WITHOUT ROWID');
  const ins = db.prepare('INSERT INTO hl_oi VALUES (?, ?, ?, ?, ?, ?)');
  const newest = NOW_S - newestAgoS;
  db.transaction(() => {
    for (let ts = newest - hours * H; ts <= newest; ts += 300) {
      const age = newest - ts; // 0 at the newest sample
      coins.forEach((c, i) => {
        let oi = 1000 * (100 - i); let mark = 10; let funding = 0.0000125;
        if (c === 'HOT') { oi = 50_000 * (age >= 24 * H ? 1 : 1.2); mark = age >= H ? 10 : 10.2; funding = 0.00005; } // +20% OI 24h, +2% 1h, 43.8% ann
        if (c === 'kPEPE') { oi = 10; mark = 0.004; }
        ins.run(c, ts, oi, mark, funding, 1e6);
      });
    }
  })();
  db.close();
}
function buildTape({ lastAgoS = 60 } = {}) {
  try { fs.unlinkSync(process.env.LIQ_DB); } catch { /* none */ }
  const db = new Database(process.env.LIQ_DB);
  db.exec("CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit'); CREATE INDEX idx_liq_sym_ts ON liquidations(symbol, ts); CREATE INDEX idx_liq_ts ON liquidations(ts);");
  const ins = db.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    // C00: $10k every hour for 7 days -> median 10k, MAD 0; last hour $200k of longs -> z = (200k-10k)/5000 = 38 -> liq_spike
    for (let h = 1; h <= 170; h++) ins.run(NOW - h * 3600_000 - 600_000, 'C00USDT', 'Buy', 1, 10, 10_000);
    ins.run(NOW - lastAgoS * 1000, 'C00USDT', 'Buy', 1, 10, 200_000);
    // HOT: shorts liquidated in the last hour, 3x the longs
    const hotTs = NOW - Math.max(900_000, lastAgoS * 1000 + 1000); // never newer than the newest print the case asks for
    ins.run(hotTs, 'HOTUSDT', 'Sell', 1, 10, 90_000);
    ins.run(hotTs, 'HOTUSDT', 'Buy', 1, 10, 30_000);
    // kPEPE lives as 1000PEPEUSDT in the tape; a 24h heatmap around price for coin-signal
    ins.run(NOW - 7200_000, '1000PEPEUSDT', 'Buy', 1, 0.0035, 5_000);
    ins.run(NOW - 7200_000, '1000PEPEUSDT', 'Sell', 1, 0.0046, 8_000);
  })();
  db.close();
}
function buildWhales({ agoS = 60 } = {}) {
  fs.writeFileSync(process.env.HL_WHALES_SNAPSHOT, JSON.stringify({ at: NOW - agoS * 1000, marks: {}, scanned: 250, withPositions: 3, positions: [
    { address: '0x1', coin: 'C00', side: 'long', size: 1, notional_usd: 3_000_000, entry_px: 9, liquidation_px: 5, liq_distance_pct: 50 },
    { address: '0x2', coin: 'C00', side: 'short', size: 1, notional_usd: 1_000_000, entry_px: 11, liquidation_px: 20, liq_distance_pct: 100 },
    { address: '0x3', coin: 'C00', side: 'long', size: 1, notional_usd: 500_000, entry_px: 9.5, liquidation_px: 7, liq_distance_pct: 30 },
    { address: '0x4', coin: 'C00', side: 'long', size: 1, notional_usd: 100_000, entry_px: 9.9, liquidation_px: 8, liq_distance_pct: 20 },
  ] }));
}

const S = require('../tools/signals');
function fresh() { S._reset(); S._memo(false); S._setClock(() => NOW); require('../lib/hl-oi').closeReader(); }

test.before(() => { buildOi(); buildTape(); buildWhales(); fresh(); });
test.after(() => { S._setClock(null); S._memo(true); require('../lib/hl-oi').closeReader(); fs.rmSync(dir, { recursive: true, force: true }); });

test('board: data.coins keyed by coin in OI order, ranked, sources with as_of, n and size bounds', async () => {
  fresh();
  const b = await S.getSignalBoard({});
  assert.equal(b.ranked.length, 30);
  assert.deepEqual(Object.keys(b.coins), b.ranked, 'object insertion order is the OI order');
  assert.equal(b.ranked[0], 'C00');
  const oi = b.ranked.map((c) => b.coins[c].oi_usd);
  assert.deepEqual(oi, [...oi].sort((x, y) => y - x));
  assert.deepEqual(Object.keys(b.sources).sort(), ['hl_oi', 'hl_whales', 'liq_tape']);
  for (const s of Object.values(b.sources)) { assert.ok(s.name); assert.match(s.as_of, /^2026-10-14T/); }
  const fields = ['mark', 'chg_1h_pct', 'chg_24h_pct', 'funding_1h', 'funding_ann_pct', 'oi_usd', 'oi_chg_1h_pct', 'oi_chg_24h_pct', 'liq_1h_long_usd', 'liq_1h_short_usd', 'liq_z', 'whale_net_usd', 'whale_tilt', 'flags'];
  assert.deepEqual(Object.keys(b.coins.C00), fields);
  const bytes = JSON.stringify({ tool: 'get_signal_board', data: b, paid: true }).length;
  assert.ok(bytes <= 12 * 1024, `n=30 is ${bytes} bytes`);
  assert.equal((await S.getSignalBoard({ n: 60 })).ranked.length, 60);
  for (const n of [0, 61, 'x', 2.5]) await assert.rejects(S.getSignalBoard({ n }), (e) => e.kind === 'bad_request');
});

test('board: every value a NOFX data_path can walk (objects only, JSON-safe)', async () => {
  fresh();
  const b = JSON.parse(JSON.stringify(await S.getSignalBoard({ n: 5 })));
  const walk = (o, p) => p.split('.').reduce((c, k) => (c && typeof c === 'object' && !Array.isArray(c) ? c[k] : undefined), o);
  assert.equal(typeof walk({ data: b }, 'data.coins.C00.mark'), 'number');
  assert.ok(Array.isArray(walk({ data: b }, 'data.ranked')));
});

test('numbers: funding, OI and price changes, whale net and tilt, liq_z, the kPEPE <-> 1000PEPEUSDT mapping', async () => {
  fresh();
  const b = await S.getSignalBoard({ coins: 'HOT,c00,1000pepe' });
  assert.deepEqual(b.ranked, ['C00', 'HOT', 'kPEPE']);
  const hot = b.coins.HOT;
  assert.equal(hot.funding_ann_pct, 43.8);
  assert.equal(hot.oi_chg_24h_pct, 20);
  assert.equal(hot.chg_1h_pct, 2);
  assert.equal(hot.liq_1h_short_usd, 90_000);
  assert.equal(hot.liq_1h_long_usd, 30_000);
  assert.equal(hot.whale_net_usd, null, 'no whale holds it');
  const c0 = b.coins.C00;
  assert.equal(c0.whale_net_usd, 2_600_000);
  assert.equal(c0.whale_tilt, 0.57); // (3.6M - 1M) / 4.6M
  assert.equal(c0.liq_z, 38);
  assert.equal(c0.oi_chg_24h_pct, 0);
  assert.equal(b.coins.kPEPE.liq_1h_long_usd, 0, 'kPEPE reads the 1000PEPEUSDT tape: recorded, quiet this hour');
  const none = (await S.getSignalBoard({ coins: 'C59' })).coins.C59;
  assert.equal(none.liq_1h_long_usd, null, 'never in the tape: null, not 0');
  assert.equal(none.liq_z, null);
});

test('flags follow the published rules', async () => {
  fresh();
  const b = await S.getSignalBoard({ coins: 'HOT,C00,C01' });
  assert.deepEqual(b.coins.HOT.flags, ['crowded_long', 'liq_spike'], 'funding 43.8% ann and OI +20% in 24h; $120k in its first recorded hour');
  assert.deepEqual(b.coins.C00.flags, ['liq_spike'], 'z 38 and $200k in the hour');
  assert.deepEqual(b.coins.C01.flags, []);
  assert.match(S.RULES.crowded_long, /funding_ann_pct >= 30/);
  assert.deepEqual(Object.keys(b.rules).sort(), ['crowded_long', 'crowded_short', 'liq_spike', 'squeeze_risk']);
});

test('24h fields are null while the sampler holds less than a day', async () => {
  buildOi({ hours: 3 }); fresh();
  const c = (await S.getSignalBoard({ coins: 'HOT' })).coins.HOT;
  assert.equal(c.oi_chg_24h_pct, null);
  assert.equal(c.chg_24h_pct, null);
  assert.equal(c.oi_chg_1h_pct, 0);
  assert.ok(!c.flags.includes('crowded_long'), 'no OI-build flag without the 24h change');
  buildOi(); fresh();
});

test('unknown coin: 400 with the supported list; too many coins: 400', async () => {
  fresh();
  await assert.rejects(S.getSignalBoard({ coins: 'C00,NOPE' }), (e) => e.kind === 'bad_request' && /NOPE/.test(e.message) && e.supported.includes('C00'));
  await assert.rejects(S.getSignalBoard({ coins: coins.slice(0, 21).join(',') }), (e) => e.kind === 'bad_request');
  await assert.rejects(S.getCoinSignal({ coin: 'NOPE' }), (e) => e.kind === 'bad_request' && Array.isArray(e.supported) && e.supported.length === coins.length);
  await assert.rejects(S.getCoinSignal({ coin: '../etc' }), (e) => e.kind === 'bad_request');
  await assert.rejects(S.getCoinSignal({}), (e) => e.kind === 'bad_request');
});

test('a stale source is a 503 with Retry-After, for each of the three', async () => {
  buildOi({ newestAgoS: 1000 }); fresh();
  await assert.rejects(S.getSignalBoard({}), (e) => e.status === 503 && e.retryAfter === 60 && /sampler/.test(e.message) && /Not charged/.test(e.message));
  await assert.rejects(S.getCoinSignal({ coin: 'C00' }), (e) => e.status === 503);
  buildOi(); buildTape({ lastAgoS: 1900 }); fresh();
  await assert.rejects(S.getSignalBoard({}), (e) => e.status === 503 && /tape/.test(e.message));
  buildTape(); buildWhales({ agoS: 901 }); fresh();
  await assert.rejects(S.getSignalBoard({}), (e) => e.status === 503 && /whale/.test(e.message));
  buildWhales(); fresh();
  await S.getSignalBoard({}); // all fresh again
});

test('coin-signal: one coin, cascade, clusters around price, top 3 whales without addresses, under 3 KB', async () => {
  fresh();
  const cascade = { getCascadeForecast: async ({ query }) => ({ answers: [{ symbol: query.symbol, p: 0.2856, evidence: 'measured', thresholdUsd: 170402.4, windowEnd: '2026-10-14T12:15:00.000Z', asOf: '2026-10-14T12:01:00.000Z' }] }) };
  const c = await S.getCoinSignal({ coin: 'c00' }, { cascade });
  assert.equal(c.coin, 'C00');
  assert.equal(c.oi_rank, 1);
  assert.deepEqual(c.cascade_15m, { p: 0.2856, evidence: 'measured', threshold_usd: 170402, window_end: '2026-10-14T12:15:00.000Z' });
  assert.equal(c.whale_top.length, 3);
  assert.deepEqual(c.whale_top[0], { side: 'long', size_usd: 3_000_000, entry_px: 9, liquidation_px: 5 });
  assert.ok(!JSON.stringify(c).includes('0x1'), 'no account addresses');
  assert.ok(c.sources.cascade_forecast && c.sources.liq_heatmap);
  const bytes = JSON.stringify({ tool: 'get_coin_signal', data: c, paid: true }).length;
  assert.ok(bytes <= 3 * 1024, `${bytes} bytes`);
  const pepe = await S.getCoinSignal({ coin: 'kPEPE' }, { cascade, liqdb: { getLiqHeatmap: async ({ symbol }) => { assert.equal(symbol, '1000PEPEUSDT'); return { levels: [
    { price_low: 0.0034, price_high: 0.0036, usd_total: 5000, longs_usd: 5000, shorts_usd: 0 },
    { price_low: 0.0045, price_high: 0.0047, usd_total: 8000, longs_usd: 0, shorts_usd: 8000 }] }; } } });
  assert.equal(pepe.liq_cluster_below.usd, 5000);
  assert.equal(pepe.liq_cluster_above.usd, 8000);
  assert.ok(pepe.liq_cluster_above.distance_pct > 0 && pepe.liq_cluster_below.distance_pct < 0);
});

test('coin-signal: a forecast model that cannot load is a null with a reason, not a 503', async () => {
  fresh();
  const down = { getCascadeForecast: async () => { throw Object.assign(new Error('cascade forecast model unavailable: /opt/caliper/x'), { status: 503 }); } };
  const c = await S.getCoinSignal({ coin: 'C00' }, { cascade: down });
  assert.equal(c.cascade_15m.p, null);
  assert.ok(!/opt/.test(c.cascade_15m.reason), 'no box paths in the answer');
});

test('the 7-day baseline is kept incrementally: a new hour adds one hour, the oldest drops out', async () => {
  fresh();
  const a = (await S.getSignalBoard({ coins: 'C00' })).coins.C00.liq_z;
  S._setClock(() => NOW + 3600_000); // an hour later: the 200k print is now inside the baseline, the tape is stale
  const db = new Database(process.env.LIQ_DB);
  db.prepare("INSERT INTO liquidations (ts, symbol, side, size, price, usd) VALUES (?, 'C00USDT', 'Buy', 1, 10, 10000)").run(NOW + 3500_000);
  db.close();
  buildOiShift();
  buildWhales({ agoS: -3540 }); S._reset();
  const b = (await S.getSignalBoard({ coins: 'C00' })).coins.C00;
  assert.equal(a, 38);
  assert.equal(b.liq_z, 0, '(10k - 10k) / 5000');
  S._setClock(() => NOW);
  buildOi(); buildTape(); buildWhales(); fresh();
});
function buildOiShift() {
  const db = new Database(process.env.HL_OI_DB);
  const ins = db.prepare('INSERT OR REPLACE INTO hl_oi VALUES (?, ?, ?, ?, ?, ?)');
  for (const c of coins) ins.run(c, NOW_S + 3480, 1000, 10, 0.0000125, 1e6);
  db.close();
  require('../lib/hl-oi').closeReader();
}
