'use strict';
// R10 addendum A1/A2 (14 Oct 2026).
//   A1  a symbol our liquidation tape has never recorded is a 400 (bad_request, never settled) on liq-history, liq-heatmap,
//       cascade-history and venue-liq-share; a recorded symbol answers, empty window or not; scope=all is untouched
//   A2  Hyperliquid's lower-case k bundles: kPEPE is the 1000PEPEUSDT perp at input; the Hyperliquid lookup finds the
//       canonical name in any case and keeps a truly unknown name unknown
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r10c-'));
const file = path.join(dir, 'liq.db');
{
  const db = new Database(file);
  db.exec(`CREATE TABLE liquidations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, size REAL NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, exchange TEXT NOT NULL DEFAULT 'bybit');
    CREATE INDEX idx_liq_sym_ts ON liquidations(symbol, ts);`);
  const ins = db.prepare('INSERT INTO liquidations (ts, symbol, side, size, price, usd, exchange) VALUES (?,?,?,?,?,?,?)');
  const now = Date.now();
  for (let i = 0; i < 5; i++) ins.run(now - i * 60_000, 'SOLUSDT', i % 2 ? 'Buy' : 'Sell', 10, 150 + i, 1500 + i * 10, 'bybit');
  ins.run(now - 30 * 86400_000, 'OLDUSDT', 'Buy', 1, 1, 1000, 'bybit'); // recorded once, long ago: known, empty window
  ins.run(now - 60_000, '1000PEPEUSDT', 'Sell', 1e6, 0.004, 4000, 'bybit');
  db.close();
}
process.env.LIQ_DB = file;
const L = require('../tools/liqdb');
const { _normSym: normSym } = require('../tools/derivs');
const H = require('../tools/hlperp');

const isBad = (fn) => { try { fn(); return false; } catch (e) { return e.kind === 'bad_request' && /never recorded/.test(e.message); } };

test('A1: an unknown symbol is a bad_request on the four tape routes; known symbols answer', () => {
  for (const [name, fn] of [['liq-history', L.getLiqHistory], ['liq-heatmap', L.getLiqHeatmap], ['cascade-history', L.getCascadeHistory], ['venue-liq-share', L.getVenueLiqShare]]) {
    assert.ok(isBad(() => fn({ symbol: 'NOPEZZ' })), `${name}: NOPEZZ refused`);
    assert.doesNotThrow(() => fn({ symbol: 'SOL' }), `${name}: SOL answers`);
    assert.doesNotThrow(() => fn({ symbol: 'OLD' }), `${name}: a recorded symbol with an empty window still answers`);
  }
  assert.ok(L.getLiqHeatmap({ symbol: 'SOL' }).levels.length > 0);
  assert.deepEqual(L.getLiqHeatmap({ symbol: 'OLD' }).levels, []);
  assert.doesNotThrow(() => L.getLiqHistory({ symbol: 'NOPEZZ', scope: 'all' }), 'scope=all ignores the symbol');
  assert.doesNotThrow(() => L.getVenueLiqShare({}), 'no symbol = the whole tape');
  assert.equal(L.tapeSymbol('SOLUSDT'), 'SOLUSDT');
});

test('A2: kPEPE (and kPEPEUSDT) is the 1000PEPEUSDT perp at input; upper-case and plain symbols are as before', () => {
  assert.equal(normSym('kPEPE'), '1000PEPEUSDT');
  assert.equal(normSym('kPEPEUSDT'), '1000PEPEUSDT');
  assert.equal(normSym('1000PEPEUSDT'), '1000PEPEUSDT');
  assert.equal(normSym('sol'), 'SOLUSDT');
  assert.equal(normSym('KAVA'), 'KAVAUSDT', 'an upper-case K coin is not a bundle');
  assert.doesNotThrow(() => L.getLiqHeatmap({ symbol: 'kPEPE' }), 'the tape knows kPEPE as 1000PEPEUSDT');
});

test('A2: the Hyperliquid lookup returns the canonical name, case-insensitively; unknown stays unknown', () => {
  const ctx = new Map([['kPEPE', {}], ['SOL', {}], ['BTC', {}], ['KAVA', {}]]);
  assert.equal(H._canonical(ctx, 'KPEPE'), 'kPEPE');
  assert.equal(H._canonical(ctx, '1000PEPE'), 'kPEPE');
  assert.equal(H._canonical(ctx, 'SOL'), 'SOL');
  assert.equal(H._canonical(ctx, 'KAVA'), 'KAVA', 'an exact name wins over a case match');
  assert.equal(H._canonical(ctx, 'NOPEZZ'), null);
});

test('A1: internal callers (market-state, coin-signal) keep reading an unrecorded symbol as an empty measurement', () => {
  assert.deepEqual(L.getLiqHeatmap({ symbol: 'NEVERUSDT' }, { tapeCheck: false }).levels, []);
  assert.equal(L.getLiqHistory({ symbol: 'NEVERUSDT' }, { tapeCheck: false }).total_usd, 0);
  assert.ok(isBad(() => L.getLiqHeatmap({ symbol: 'NEVERUSDT', tapeCheck: false })), 'a query string cannot switch the check off');
});
