// tools/pegonchain.js — the peg tape's token side read from chain state (R5 C3).
//
// Until 12 Oct 2026 the token side of the peg tape (price and pool liquidity of each Solana
// xStock) came only from the pegwatch collector, which reads it from DexScreener, whose terms
// forbid redistribution (docs/SOURCES.md). This module reads the same pools directly: one
// getMultipleAccounts for every pool and both of its vaults, price from the pool's sqrt price,
// liquidity as both vaults at that price. Pools are in data/peg-pools.json, chosen on-chain on
// 12 Oct (getProgramAccounts on each mint over Raydium CLMM and Orca Whirlpool, deepest by both
// vaults); at that read they matched pegwatch's pools to the cent.
//
// The reference side is unchanged: pegwatch's latest US-market reference for the same symbol
// (read-only), so a deviation computed here is comparable with the history before the cutover.
// collect() runs from root cron (bin/peg-collect.js) and writes peg-onchain.db; the routes read it.
'use strict';
const path = require('path');
const fs = require('fs');

const DB_PATH = () => process.env.PEG_ONCHAIN_DB || path.join(__dirname, '..', 'peg-onchain.db');
const PEGWATCH_DB = () => process.env.PEGWATCH_DB || '/opt/pegwatch/pegwatch.db';
const POOLS = require('../data/peg-pools.json').pools;
const SOL_RPC = () => process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY || ''}`;
const REF_MAX_AGE_S = 15 * 60;
// sqrt price offsets as in tools/dexspot.js; vaults: Raydium CLMM 137/169, Orca Whirlpool 133/213
const LAYOUT = {
  'raydium-clmm': { sqrt: 253, m0: 73, m1: 105, v0: 137, v1: 169 },
  'orca-whirlpool': { sqrt: 65, m0: 101, m1: 181, v0: 133, v1: 213 },
};
const QUOTE_DEC = { USDC: 6, SOL: 9 };

const { _b58: b58 } = require('./dexspot');
const u128 = (b, o) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };

async function rpc(method, params) {
  const r = await fetch(SOL_RPC(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`solana rpc http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`solana rpc: ${String(j.error.message || '').slice(0, 80)}`);
  return j.result;
}

/** pool account bytes + vault amounts -> { price_usd, liq_usd } ; quoteUsd is 1 for USDC, the SOL price for SOL */
function priceOf(p, data, a0, a1, quoteUsd) {
  const L = LAYOUT[p.kind];
  const m0 = b58(data.subarray(L.m0, L.m0 + 32)), m1 = b58(data.subarray(L.m1, L.m1 + 32));
  if ((p.token_is_0 ? m0 : m1) !== p.mint || (p.token_is_0 ? m1 : m0) !== p.quote_mint) throw new Error(`${p.symbol}: pool mints do not match`);
  const s = Number(u128(data, L.sqrt)) / 2 ** 64;
  const qd = QUOTE_DEC[p.quote];
  const d0 = p.token_is_0 ? p.decimals : qd, d1 = p.token_is_0 ? qd : p.decimals;
  const oneInZero = s * s * 10 ** (d0 - d1); // token1 per token0, human units
  const inQuote = p.token_is_0 ? oneInZero : 1 / oneInZero;
  const price = inQuote * quoteUsd;
  const tok = (p.token_is_0 ? a0 : a1) / 10 ** p.decimals, quo = (p.token_is_0 ? a1 : a0) / 10 ** qd;
  return { price_usd: price, liq_usd: tok * price + quo * quoteUsd };
}

async function readAll() {
  const pools = await rpc('getMultipleAccounts', [POOLS.map((p) => p.pool), { encoding: 'base64', commitment: 'confirmed' }]);
  const datas = pools.value.map((a) => (a ? Buffer.from(a.data[0], 'base64') : null));
  const vaults = [];
  POOLS.forEach((p, i) => { const d = datas[i]; if (!d) return; const L = LAYOUT[p.kind]; vaults.push(b58(d.subarray(L.v0, L.v0 + 32)), b58(d.subarray(L.v1, L.v1 + 32))); });
  const va = await rpc('getMultipleAccounts', [vaults, { encoding: 'base64', commitment: 'confirmed' }]);
  const amt = new Map(vaults.map((v, i) => [v, va.value[i] ? Number(Buffer.from(va.value[i].data[0], 'base64').readBigUInt64LE(64)) : null]));
  const needSol = POOLS.some((p) => p.quote === 'SOL');
  const sol = needSol ? (await require('./prices').getPrice('SOL')).price : null;
  const out = [];
  POOLS.forEach((p, i) => {
    const d = datas[i];
    if (!d) { out.push({ symbol: p.symbol, error: 'pool account not found' }); return; }
    const L = LAYOUT[p.kind];
    const a0 = amt.get(b58(d.subarray(L.v0, L.v0 + 32))), a1 = amt.get(b58(d.subarray(L.v1, L.v1 + 32)));
    try {
      if (a0 == null || a1 == null) throw new Error('vault not found');
      out.push({ symbol: p.symbol, pool: p.pool, dex: p.kind, ...priceOf(p, d, a0, a1, p.quote === 'SOL' ? sol : 1), slot: pools.context && pools.context.slot });
    } catch (e) { out.push({ symbol: p.symbol, error: e.message }); }
  });
  return out;
}

let _db = null;
function db(readonly = true) {
  if (_db && _db.readonly === readonly) return _db;
  const Database = require('better-sqlite3');
  if (readonly && !fs.existsSync(DB_PATH())) return null;
  _db = new Database(DB_PATH(), readonly ? { readonly: true, fileMustExist: true } : {});
  if (!readonly) {
    _db.pragma('journal_mode = WAL');
    _db.exec(`CREATE TABLE IF NOT EXISTS ticks (ts INTEGER NOT NULL, symbol TEXT NOT NULL, onchain REAL NOT NULL, ref REAL, ref_source TEXT,
      session TEXT, dev_bps REAL, liq_usd REAL NOT NULL, dex TEXT NOT NULL, pool TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_ticks_sym_ts ON ticks(symbol, ts);`);
  }
  return _db;
}

/** one collection pass: read every pool, pair each with pegwatch's latest reference, insert */
async function collect({ now = Date.now(), log = console.log } = {}) {
  const rows = await readAll();
  const ts = Math.floor(now / 1000);
  let pw = null;
  try { const Database = require('better-sqlite3'); pw = new Database(PEGWATCH_DB(), { readonly: true, fileMustExist: true }); } catch (e) { log(`pegwatch reference unavailable: ${e.message}`); }
  const ref = pw ? pw.prepare('SELECT ts, ref, ref_source, session FROM ticks WHERE symbol = ? ORDER BY ts DESC LIMIT 1') : null;
  const w = db(false);
  const ins = w.prepare('INSERT INTO ticks (ts, symbol, onchain, ref, ref_source, session, dev_bps, liq_usd, dex, pool) VALUES (?,?,?,?,?,?,?,?,?,?)');
  let ok = 0; const errs = [];
  w.transaction(() => {
    for (const r of rows) {
      if (r.error) { errs.push(`${r.symbol}: ${r.error}`); continue; }
      const f = ref ? ref.get(r.symbol) : null;
      const fresh = f && ts - f.ts <= REF_MAX_AGE_S;
      ins.run(ts, r.symbol, r.price_usd, fresh ? f.ref : null, fresh ? f.ref_source : null, fresh ? f.session : null,
        fresh ? ((r.price_usd - f.ref) / f.ref) * 10_000 : null, r.liq_usd, r.dex, r.pool);
      ok++;
    }
  })();
  if (pw) pw.close();
  return { ok, errors: errs };
}

/** newest row per symbol from our own tape, or null if it is older than maxAgeS */
function latest(symbol, { maxAgeS = 20 * 60, now = Date.now() } = {}) {
  const d = db(true);
  if (!d) return null;
  const r = d.prepare('SELECT * FROM ticks WHERE symbol = ? ORDER BY ts DESC LIMIT 1').get(symbol);
  return r && Math.floor(now / 1000) - r.ts <= maxAgeS ? r : null;
}
/** first ts of our own tape: rows at or after it are ours, rows before it are pegwatch's */
function cutover() {
  const d = db(true);
  if (!d) return null;
  const r = d.prepare('SELECT MIN(ts) t FROM ticks').get();
  return r && r.t;
}
function rows(symbol, since, cols) {
  const d = db(true);
  if (!d) return [];
  return d.prepare(`SELECT ${cols} FROM ticks WHERE symbol = ? AND ts >= ? AND dev_bps IS NOT NULL ORDER BY ts ASC`).all(symbol, since);
}

module.exports = { POOLS, collect, latest, cutover, rows, _priceOf: priceOf, _reset: () => { if (_db) _db.close(); _db = null; } };
