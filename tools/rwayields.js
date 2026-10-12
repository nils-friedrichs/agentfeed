// tools/rwayields.js — /api/rwa-yields: the current state of the RWAYield index (R3, 2026-10-12).
//
// READ-ONLY, CURRENT STATE ONLY. rwayield.db is written by the RWAYield indexer (pm2
// rwayield-idx, every 6 hours). This handle is readonly + fileMustExist, so the paid
// read path cannot write to it. No history series is returned: the time series is
// RWAYield's licensed product; this route sells the latest snapshot per product plus one
// derived figure, the 7-day TVL change.
//
// HONEST NULLS. The index takes yield and TVL from DefiLlama, matched on the issuer's own
// project slug (never the ticker alone, see /opt/rwayield/README.md). NAV, market price,
// premium to NAV and DEX pool depth have no per-issuer source yet, so they are null and
// the product's flags say why. Six of thirteen products are unverified and carry no
// numbers at all, with the reason. A null is never coerced to 0.
//
// STALE = 503. The indexer runs every 6 hours; a newest snapshot older than 8 hours
// (one interval plus two hours of error backoff) answers 503, which is never settled.
'use strict';
const Database = require('better-sqlite3');

const DB_PATH = () => process.env.RWAYIELD_DB || '/opt/rwayield/rwayield.db';
const STALE_S = 8 * 3600;
const FLOW_DAYS = 7;
const CATEGORIES = ['treasury', 'mmf', 'credit', 'commodity', 'equity'];

let db = null;
function open() {
  if (!db) db = new Database(DB_PATH(), { readonly: true, fileMustExist: true });
  return db;
}

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const stale = (msg) => Object.assign(new Error(msg), { status: 503 });
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => (fin(v) == null ? null : Math.round(v * 100) / 100);
const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function getRwaYields(p = {}, { now = Math.floor(Date.now() / 1000) } = {}) {
  const symbol = p.symbol == null || p.symbol === '' ? null : String(p.symbol).trim();
  const category = p.category == null || p.category === '' ? null : String(p.category).trim().toLowerCase();
  if (category && !CATEGORIES.includes(category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
  if (symbol && !/^[A-Za-z0-9.\-]{1,24}$/.test(symbol)) throw bad('symbol must be a product ticker such as BUIDL, USDY or OUSG');

  const d = open();
  const newest = d.prepare('SELECT MAX(ts) AS ts FROM snapshots').get().ts;
  if (!newest || now - newest > STALE_S) {
    throw stale(`RWAYield index is stale: newest snapshot ${newest ? `${Math.round((now - newest) / 3600)}h old` : 'missing'}, limit 8h. Not charged.`);
  }

  const rows = d.prepare(`
    SELECT p.id, p.key, p.symbol, p.name, p.issuer, p.category, p.chain, p.duration_days,
           p.verified, p.unverified_reason,
           s.ts, s.price, s.nav, s.premium_bps, s.yield_apy, s.tvl_usd, s.pool_depth_usd,
           s.pool_count, s.chain_breakdown, s.source, s.flags
    FROM products p
    LEFT JOIN snapshots s ON s.product_id = p.id
      AND s.ts = (SELECT MAX(ts) FROM snapshots s2 WHERE s2.product_id = p.id)
    WHERE p.active = 1
    ORDER BY p.symbol`).all();

  const known = rows.map((r) => r.symbol);
  if (symbol && !known.some((k) => k.toLowerCase() === symbol.toLowerCase())) {
    throw bad(`unknown symbol ${symbol}: the index covers ${known.join(', ')}`);
  }

  const cutoff = now - FLOW_DAYS * 86400;
  const latestTvl = d.prepare('SELECT tvl_usd, ts FROM snapshots WHERE product_id=? AND tvl_usd IS NOT NULL ORDER BY ts DESC LIMIT 1');
  const priorTvl = d.prepare('SELECT tvl_usd, ts FROM snapshots WHERE product_id=? AND tvl_usd IS NOT NULL AND ts<=? ORDER BY ts DESC LIMIT 1');

  const products = rows
    .filter((r) => (!symbol || r.symbol.toLowerCase() === symbol.toLowerCase()) && (!category || r.category === category))
    .map((r) => {
      const cur = latestTvl.get(r.id);
      const prev = priorTvl.get(r.id, cutoff);
      const flow = cur && prev && cur.ts !== prev.ts ? cur.tvl_usd - prev.tvl_usd : null;
      const cb = json(r.chain_breakdown, null);
      return {
        symbol: r.symbol, name: r.name, issuer: r.issuer, category: r.category,
        duration_days: r.duration_days,
        verified: Boolean(r.verified),
        ...(r.verified ? {} : { unverified_reason: r.unverified_reason }),
        yield_apy_pct: fin(r.yield_apy),
        nav_usd: fin(r.nav), price_usd: fin(r.price), premium_bps: r2(r.premium_bps),
        tvl_usd: r2(r.tvl_usd), pool_depth_usd: r2(r.pool_depth_usd),
        tvl_change_7d_usd: r2(flow),
        tvl_change_7d_pct: flow != null && prev.tvl_usd ? r2((flow / prev.tvl_usd) * 100) : null,
        tvl_change_7d_from: flow != null ? iso(prev.ts) : null,
        chains: cb ? Object.entries(cb).sort((a, b) => b[1] - a[1]).map(([chain, tvl]) => ({ chain, tvl_usd: r2(tvl) })) : [],
        pool_count: r.pool_count,
        flags: json(r.flags, []),
        source: r.source,
        as_of: iso(r.ts),
      };
    })
    .sort((a, b) => (b.tvl_usd || 0) - (a.tvl_usd || 0));

  return {
    as_of: iso(newest),
    age_minutes: Math.round((now - newest) / 60),
    count: products.length,
    products,
    method: 'Latest RWAYield snapshot per product. Yield (APY %) and TVL come from DefiLlama yields, matched on the issuer project slug and TVL-weighted across pools and chains. tvl_change_7d is the TVL change against the newest snapshot at least 7 days old, which approximates net flow for products priced near $1. NAV, price, premium and pool depth are null until a per-issuer source exists; flags name each gap.',
    source: 'RWAYield index, refreshed every 6 hours; underlying yields and TVL: DefiLlama',
  };
}

module.exports = { getRwaYields, _CATEGORIES: CATEGORIES };
