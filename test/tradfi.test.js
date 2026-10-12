// test/tradfi.test.js — session labels, radar ranking/filters, equity-24h contract.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradfi-'));
process.env.FUNDING_RADAR_SNAPSHOT = path.join(dir, 'fr.json');
process.env.PEGWATCH_DB = path.join(dir, 'none.db');
process.env.PEG_ONCHAIN_DB = path.join(dir, 'none-onchain.db');
const T = require('../tools/tradfi');
const at = (s) => Date.parse(s);

test('session labels in New York time', () => {
  assert.equal(T.sessionLabel(at('2026-10-08T14:00:00Z')), 'open');      // Thu 10:00 EDT
  assert.equal(T.sessionLabel(at('2026-10-08T12:00:00Z')), 'pre');       // Thu 08:00
  assert.equal(T.sessionLabel(at('2026-10-08T21:00:00Z')), 'after');     // Thu 17:00
  assert.equal(T.sessionLabel(at('2026-10-09T02:00:00Z')), 'overnight'); // Thu 22:00
  assert.equal(T.sessionLabel(at('2026-10-10T01:00:00Z')), 'weekend');   // Fri 21:00
  assert.equal(T.sessionLabel(at('2026-10-11T15:00:00Z')), 'weekend');   // Sun 11:00
  assert.equal(T.sessionLabel(at('2026-10-12T01:00:00Z')), 'overnight'); // Sun 21:00
});

function snap(now, markets) {
  fs.writeFileSync(process.env.FUNDING_RADAR_SNAPSHOT, JSON.stringify({ tradfi: { as_of: new Date(now).toISOString(), as_of_ms: now, min_track_usd: 250000, dexes: [], markets } }));
  const t = new Date(Date.now() + Math.random() * 1e6); fs.utimesSync(process.env.FUNDING_RADAR_SNAPSHOT, t, t);
}
const M = (venue, ticker, cls, f8, oi, mark = 100) => ({ venue, market: venue === 'hyperliquid' ? `xyz:${ticker}` : undefined, symbol: `${ticker}USDT`, ticker, asset_class: cls, funding_rate_8h: f8, oi_usd: oi, volume_24h_usd: 1e6, mark });

test('radar ranks by |funding 8h|, filters by class and venue; a venue with no OI survives min_oi 0 only (venues: hyperliquid, bybit)', () => {
  const now = Date.now();
  snap(now, [M('hyperliquid', 'TSLA', 'stock', 0.0001, 5e6), M('bybit', 'XAU', 'commodity', -0.003, null), M('bybit', 'US500', 'index', 0.001, 2e6)]);
  const r = T.getTradfiRadar({}, { now });
  assert.deepEqual(r.markets.map((m) => m.ticker), ['XAU', 'US500', 'TSLA']);
  assert.deepEqual(T.getTradfiRadar({ class: 'stock' }, { now }).markets.map((m) => m.ticker), ['TSLA']);
  assert.deepEqual(T.getTradfiRadar({ venue: 'bybit' }, { now }).markets.map((m) => m.ticker), ['XAU', 'US500']);
  assert.deepEqual(T.getTradfiRadar({}, { now }).venues, ['hyperliquid (HIP-3 dexes)', 'bybit'], 'Binance and OKX are not venues any more (R6 D2)');
  assert.deepEqual(T.getTradfiRadar({ min_oi_usd: 1e6 }, { now }).markets.map((m) => m.ticker), ['US500', 'TSLA']);
  assert.throws(() => T.getTradfiRadar({ class: 'crypto' }, { now }), (e) => e.kind === 'bad_request');
});

test('stale snapshot -> 503; unknown ticker -> 503; missing symbol -> 400', async () => {
  const now = Date.now();
  snap(now - 3600e3, [M('hyperliquid', 'TSLA', 'stock', 0, 5e6)]);
  assert.throws(() => T.getTradfiRadar({}, { now }), (e) => e.status === 503);
  snap(now, [M('hyperliquid', 'TSLA', 'stock', 0, 5e6)]);
  const down = async () => new Response('down', { status: 502 });
  await assert.rejects(T.getEquity24h({ symbol: 'ZZZZQ' }, { now, fetchImpl: down }), (e) => e.status === 503);
  await assert.rejects(T.getEquity24h({}, { now, fetchImpl: down }), (e) => e.kind === 'bad_request');
  const e = await T.getEquity24h({ symbol: 'tsla' }, { now, fetchImpl: down });
  assert.equal(e.indicative, true);
  assert.equal(e.indicative_price, 100);
  assert.equal(e.last_regular_session.price, null, 'candles down: no reference, never a guess');
});

test('last regular-session close: the last hourly HIP-3 candle ending 10:00-16:00 New York on a weekday', async () => {
  // Mon 12 Oct 2026; candles ending 19:00Z (15:00 EDT), 20:00Z (16:00 EDT) and 21:00Z (17:00 EDT)
  const end = (iso) => Date.parse(iso) - 1;
  const candles = [{ T: end('2026-10-12T19:00:00Z'), c: '370' }, { T: end('2026-10-12T20:00:00Z'), c: '378.47' }, { T: end('2026-10-12T21:00:00Z'), c: '380' }];
  const seen = [];
  const f = async (url, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify(candles)); };
  const sat = Date.parse('2026-10-17T15:00:00Z'); // Saturday: the Monday 16:00 close is still the last
  const r = await T._lastRegularClose('xyz:TSLA', sat, f);
  assert.equal(r.price, 378.47);
  assert.equal(r.as_of, '2026-10-12T20:00:00.000Z');
  assert.match(r.source, /Hyperliquid HIP-3 xyz:TSLA perp/);
  assert.equal(seen[0].type, 'candleSnapshot');
  assert.equal(seen[0].req.coin, 'xyz:TSLA');
  // during the session the newest finished in-session candle is the answer
  const r2 = await T._lastRegularClose('xyz:TEST2', Date.parse('2026-10-12T19:30:00Z'), f);
  assert.equal(r2.price, 370);
});
