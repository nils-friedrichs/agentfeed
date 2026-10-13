// test/funding-radar.test.js — the radar's statistics and its cache contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fradar-'));
process.env.FUNDING_RADAR_SNAPSHOT = path.join(dir, 'snap.json');
const R = require('../tools/fundingradar');

const H = 3_600_000;

test('8h series: interval is the spacing to the previous settlement', () => {
  const rows = [{ ts: 0, rate: 0.0001 }, { ts: 8 * H, rate: 0.0001 }, { ts: 12 * H, rate: 0.0001 }];
  const s = R._to8hSeries(rows, { fallbackIntervalH: 8 });
  assert.equal(s.length, 2); // the first row is only a predecessor
  assert.equal(s[0].r8, 0.0001); // 8h spacing: unchanged
  assert.equal(s[1].r8, 0.0002); // 4h spacing: doubled
});

test('8h series: a gap wider than 8.5h falls back to the current interval, hourly venues are fixed', () => {
  const s = R._to8hSeries([{ ts: 0, rate: 0.0001 }, { ts: 24 * H, rate: 0.0001 }], { fallbackIntervalH: 4 });
  assert.equal(s[0].r8, 0.0002);
  const hl = R._to8hSeries([{ ts: 0, rate: 0.00001 }, { ts: H, rate: 0.00002 }], { fixedIntervalH: 1 });
  assert.deepEqual(hl.map((p) => p.r8), [0.00008, 0.00016]);
});

test('window stats report the window actually used, and no z under 10 samples', () => {
  const now = 30 * 24 * H;
  const series = Array.from({ length: 5 }, (_, i) => ({ ts: now - i * 24 * H, r8: 0.0001 * (i + 1) }));
  const st = R._windowStats(series, 0, now);
  assert.equal(st.samples, 5);
  assert.equal(st.window_days, 4);
  const z = R._zScore(0.001, st);
  assert.equal(z.z, null);
  assert.match(z.z_note, /only 5 settled rates/);
});

test('z-score is (current - mean) / sample std; flat history gives no z', () => {
  const st = { samples: 10, mean_8h: 0.0001, std_8h: 0.00005 };
  assert.equal(R._zScore(0.0002, st).z, 2);
  assert.equal(R._zScore(0.0002, { samples: 10, mean_8h: 0.0001, std_8h: 0 }).z, null);
  assert.equal(R._zScore(null, st).z, null);
});

test('radar row: one venue, the |z| >= 2 flag, and no cross-venue field (R7: Hyperliquid is the only venue)', () => {
  const row = R._radarRow('XUSDT', {
    hyperliquid: { funding_rate_8h: 0.0003, z_30d: 2.4 },
    bybit: { funding_rate_8h: -0.01, z_30d: 9 }, // negative control: a second venue's reading must never reach the row
  }, 3e6);
  assert.deepEqual(Object.keys(row.venues), ['hyperliquid']);
  assert.equal(row.venues.bybit, undefined);
  assert.equal(row.max_abs_z, 2.4);
  assert.equal(row.flag, true);
  assert.equal(row.oi_usd, 3e6);
  for (const k of ['spread_8h', 'spread_high_venue', 'spread_low_venue', 'extreme_venue', 'flagged_venues']) assert.equal(k in row, false, `${k} is gone`);
  // a perp with no reading is null, not dropped
  assert.equal(R._radarRow('YUSDT', {}, 1).venues.hyperliquid, null);
  assert.equal(R._radarRow('ZUSDT', { hyperliquid: { funding_rate_8h: 0.0001, z_30d: 0.5 } }, 1).flag, false);
});

test('a HIP-3 market becomes a radar row with its dex and asset class', () => {
  const r = R._hip3Row({ market: 'xyz:TSLA', dex: 'xyz', asset_class: 'stock', underlying: 'Tesla', funding_rate_8h: 0.0004, funding_rate_1h: 0.00005, z_30d: -2.5, samples: 700, window_days: 29.1, oi_usd: 4e6, mean_8h_30d: 0.0001, std_8h_30d: 0.00012 });
  assert.equal(r.symbol, 'xyz:TSLA');
  assert.equal(r.coin, 'xyz:TSLA');
  assert.equal(r.dex, 'xyz');
  assert.equal(r.asset_class, 'stock');
  assert.equal(r.venues.hyperliquid.funding_rate_8h, 0.0004);
  assert.equal(r.venues.hyperliquid.funding_interval_hours, 1);
  assert.equal(r.max_abs_z, 2.5);
  assert.equal(r.flag, true);
  assert.equal(r.oi_usd, 4e6);
});

test('sorted by largest |z|, then by |funding|; rows without a z last', () => {
  const v = (f) => ({ hyperliquid: { funding_rate_8h: f } });
  const rows = [{ max_abs_z: null, venues: v(0.0009) }, { max_abs_z: 1, venues: v(0) }, { max_abs_z: 3, venues: v(0) }, { max_abs_z: null, venues: v(0.0001) }];
  assert.deepEqual(rows.sort(R._byExtremity).map((r) => [r.max_abs_z, r.venues.hyperliquid.funding_rate_8h]), [[3, 0], [1, 0], [null, 0.0009], [null, 0.0001]]);
});

function writeSnap(asOfMs, n = 30, version = R.SNAPSHOT_VERSION) {
  const symbols = Array.from({ length: n }, (_, i) => ({ symbol: `S${i}USDT`, oi_usd: (n - i) * 1e6, max_abs_z: n - i }));
  fs.writeFileSync(process.env.FUNDING_RADAR_SNAPSHOT, JSON.stringify({
    version, as_of: new Date(asOfMs).toISOString(), as_of_ms: asOfMs,
    universe_floor_oi_usd: 0, window_target_days: 30, coverage: {}, perps: { total: n, by_dex: { main: n } }, symbols,
  }));
  // a fresh mtime so the reader's cache picks the new file up
  const t = new Date(Date.now() + Math.random() * 1000);
  fs.utimesSync(process.env.FUNDING_RADAR_SNAPSHOT, t, t);
}

test('no parameters: useful defaults (top 20, min OI $10M), fresh, one venue', () => {
  const now = Date.now();
  writeSnap(now - 60_000);
  const r = R.getFundingRadar({}, { now });
  assert.equal('stale' in r, false, 'the stale flag is gone: stale is a 503 now');
  assert.deepEqual(r.venues, ['hyperliquid']);
  assert.equal(r.min_oi_usd, 10e6);
  assert.equal(r.matched, 21); // totals 30M..10M
  assert.equal(r.returned, 20);
  assert.equal(r.symbols.length, 20);
  assert.equal(r.universe_size, 30);
  assert.deepEqual(r.universe, { total: 30, by_dex: { main: 30 } });
});

test('a snapshot past the staleness bound is a 503 with the reason, never a stale answer (R7 R4)', () => {
  const now = Date.now();
  writeSnap(now - 3600_000);
  assert.throws(() => R.getFundingRadar({}, { now }), (e) => e.status === 503 && /3600s old/.test(e.message) && /Not charged/.test(e.message));
  writeSnap(now - (R.STALE_AFTER_S - 5) * 1000);
  assert.equal(R.getFundingRadar({}, { now }).age_s, R.STALE_AFTER_S - 5, 'just inside the bound still answers');
});

test('a snapshot in the old two-venue format is "not built yet" (503), never read as the new shape', () => {
  const now = Date.now();
  writeSnap(now, 5, 1);
  assert.throws(() => R.getFundingRadar({}, { now }), (e) => e.status === 503 && /has not been built yet/.test(e.message));
  assert.equal(R.getRadarRow('S0USDT', { now }), null);
});

test('min_oi_usd has no floor now: 0 returns every perp; garbage is a 400', () => {
  const now = Date.now();
  writeSnap(now);
  const r = R.getFundingRadar({ min_oi_usd: '0', top: '100' }, { now });
  assert.equal(r.min_oi_usd, 0);
  assert.equal('min_oi_note' in r, false);
  assert.equal(r.returned, 30);
  assert.throws(() => R.getFundingRadar({ min_oi_usd: 'abc' }, { now }), (e) => e.kind === 'bad_request');
});

test('no snapshot yet: a 503, not an empty answer', () => {
  fs.rmSync(process.env.FUNDING_RADAR_SNAPSHOT);
  assert.throws(() => R.getFundingRadar({}), (e) => e.status === 503 && /has not been built yet/.test(e.message));
});
