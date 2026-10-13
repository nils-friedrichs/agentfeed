// lib/hl-oi.js — the Hyperliquid open-interest sampler's store (R7 R1c).
//
// bin/hl-oi-collect.js writes one row per coin every 5 minutes (one metaAndAssetCtxs call) and keeps 7 days.
// get_oi_spike_scan, get_squeeze_score and get_positioning read it. Hyperliquid's info API offers the CURRENT
// open interest only, so a history exists only from the day this sampler started: every reader asks warm()
// and answers 503 + Retry-After (never billed) until the window it needs is covered.
//
// `oi` is in base-coin units (Hyperliquid's own unit): a change in it is new positions, not a price move.
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = () => process.env.HL_OI_DB || path.join(__dirname, '..', 'hl-oi.db');
const RETAIN_S = 7 * 86400;
const STEP_S = 300;
const FRESH_S = 900;        // a newest sample older than this means the sampler is not running (the watchdog limit)
const SCHEMA = `CREATE TABLE IF NOT EXISTS hl_oi (
  coin TEXT NOT NULL, ts INTEGER NOT NULL, oi REAL NOT NULL, mark REAL, funding REAL, vol24 REAL,
  PRIMARY KEY (coin, ts)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS hl_oi_ts ON hl_oi(ts);`;

const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** writer (the collector only) */
function openRw() {
  const db = new Database(DB_FILE());
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** one sample: [meta, assetCtxs] from metaAndAssetCtxs -> rows. Delisted coins and coins without OI are skipped. */
function rowsFrom(payload, ts) {
  const [meta, ctxs] = payload;
  const out = [];
  meta.universe.forEach((u, i) => {
    const c = ctxs[i];
    if (!c || u.isDelisted) return;
    const oi = n(c.openInterest);
    if (oi == null) return;
    out.push([u.name, ts, oi, n(c.markPx), n(c.funding), n(c.dayNtlVlm)]);
  });
  return out;
}

/** store a sample and prune what is older than 7 days; returns { rows, pruned } */
function record(db, rows, ts) {
  const ins = db.prepare('INSERT OR REPLACE INTO hl_oi (coin, ts, oi, mark, funding, vol24) VALUES (?, ?, ?, ?, ?, ?)');
  const tx = db.transaction((rs) => { for (const r of rs) ins.run(...r); return rs.length; });
  const written = tx(rows);
  const pruned = db.prepare('DELETE FROM hl_oi WHERE ts < ?').run(ts - RETAIN_S).changes;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* a reader holds the log: the next run truncates it */ }
  return { rows: written, pruned };
}

let _ro = null;
/** reader (the server process): read-only, opened lazily, null while the sampler has never run */
function reader() {
  if (_ro) return _ro;
  try { _ro = new Database(DB_FILE(), { readonly: true, fileMustExist: true }); } catch { _ro = null; }
  return _ro;
}
function closeReader() { if (_ro) { try { _ro.close(); } catch { /* already closed */ } _ro = null; } }

/**
 * Is a lookback of `needS` seconds covered by fresh samples?
 * -> { warm, first_ts, last_ts, samples, ready_at (epoch s, when it will be warm), ready_in_min, stale }
 */
function warm(needS, db = reader(), now = Math.floor(Date.now() / 1000)) {
  const none = { warm: false, first_ts: null, last_ts: null, samples: 0, ready_at: null, ready_in_min: null, stale: true };
  if (!db) return none;
  let r;
  try { r = db.prepare('SELECT MIN(ts) AS a, MAX(ts) AS b, COUNT(DISTINCT ts) AS k FROM hl_oi').get(); } catch { return none; }
  if (!r || r.a == null) return none;
  const stale = now - r.b > FRESH_S;
  const readyAt = r.a + needS; // the oldest sample must be a full window older than the newest one the readers will use
  const ok = !stale && r.b >= readyAt;
  return { warm: ok, first_ts: r.a, last_ts: r.b, samples: r.k, ready_at: readyAt, ready_in_min: ok ? 0 : Math.max(1, Math.ceil((readyAt - now) / 60)), stale };
}

/** newest sample per coin at or before `ts` (default newest overall): Map coin -> { ts, oi, mark, funding, vol24 } */
function snapshot(db, ts = null) {
  const at = ts == null ? db.prepare('SELECT MAX(ts) AS t FROM hl_oi').get().t : db.prepare('SELECT MAX(ts) AS t FROM hl_oi WHERE ts <= ?').get(ts).t;
  const m = new Map();
  if (at == null) return m;
  for (const r of db.prepare('SELECT coin, ts, oi, mark, funding, vol24 FROM hl_oi WHERE ts = ?').iterate(at)) m.set(r.coin, r);
  return m;
}

/** every sample of one coin over the last `secs` seconds, oldest first */
function series(db, coin, secs, now = Math.floor(Date.now() / 1000)) {
  return db.prepare('SELECT ts, oi, mark, funding FROM hl_oi WHERE coin = ? AND ts >= ? ORDER BY ts').all(coin, now - secs);
}

/** every coin's samples over the last `secs` seconds as Map coin -> [{ ts, oi, mark }] (one pass, ordered) */
function allSeries(db, secs, now = Math.floor(Date.now() / 1000)) {
  const m = new Map();
  for (const r of db.prepare('SELECT coin, ts, oi, mark FROM hl_oi WHERE ts >= ? ORDER BY coin, ts').iterate(now - secs)) {
    let a = m.get(r.coin); if (!a) m.set(r.coin, (a = []));
    a.push(r);
  }
  return m;
}

module.exports = { DB_FILE, RETAIN_S, STEP_S, FRESH_S, openRw, rowsFrom, record, reader, closeReader, warm, snapshot, series, allSeries };
