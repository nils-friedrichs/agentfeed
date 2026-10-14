// tools/hlperp.js — Hyperliquid perp reads, the venue every perp route stands on (R5 C6; since R7 the only one).
//
// Hyperliquid's info API is public chain state and its terms carry no data or redistribution
// restriction (docs/SOURCES.md, clean). The centralised exchanges were read beside it until R6/R7; their
// terms forbid resale, so every perp route now answers from Hyperliquid alone.
//
// Two ways in. block() never throws (a note inside a 200): only for a part of a larger answer.
// only() is for a route whose whole answer IS the Hyperliquid read: a symbol it does not list is a
// 400 and a failed read is a 503 with Retry-After, so neither is ever billed (R4 / R7).
//
// Symbols: a USDT-style perp name SOLUSDT is Hyperliquid coin SOL; a multiplied perp 1000PEPEUSDT is
// kPEPE (Hyperliquid lists 1000x bundles with a k prefix: kPEPE, kSHIB, kBONK ... read from its
// universe on 12 Oct 2026). A coin Hyperliquid does not list gets { listed: false }.
'use strict';
const { cached } = require('../lib/cache');

const API = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const n = (v) => (v == null || v === '' ? null : Number(v));

async function info(body, timeoutMs = 8000) {
  const r = await fetch(API(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}

/** every listed perp's context, keyed by coin; 30 s cache */
const contexts = () => cached('hl:ctx', 30_000, async () => {
  const [meta, ctxs] = await info({ type: 'metaAndAssetCtxs' });
  const out = new Map();
  meta.universe.forEach((u, i) => {
    const c = ctxs[i]; if (!c || u.isDelisted) return;
    const mark = n(c.markPx);
    out.set(u.name, { coin: u.name, mark, oracle: n(c.oraclePx), mid: n(c.midPx), funding_1h: n(c.funding), premium: n(c.premium),
      oi_base: n(c.openInterest), oi_usd: mark != null && n(c.openInterest) != null ? Math.round(n(c.openInterest) * mark) : null,
      prev_day: n(c.prevDayPx), volume_24h_usd: n(c.dayNtlVlm) != null ? Math.round(n(c.dayNtlVlm)) : null, max_leverage: u.maxLeverage ?? null });
  });
  return out;
});

// R10 A2: Hyperliquid's own name for an upper-cased base (KPEPE -> kPEPE), read from its universe, never hard-coded
const upperIndex = new WeakMap();
function byUpper(ctx, base) {
  let idx = upperIndex.get(ctx);
  if (!idx) { idx = new Map(); for (const k of ctx.keys()) if (!idx.has(k.toUpperCase())) idx.set(k.toUpperCase(), k); upperIndex.set(ctx, idx); }
  return idx.get(String(base).toUpperCase()) || null;
}

/** the Hyperliquid coin for a base: exact, a 1000x bundle (1000PEPE -> kPEPE), or the same name in another case */
function canonical(ctx, base) {
  if (ctx.has(base)) return base;
  const m = /^10{3,}([A-Z0-9]+)$/.exec(base);
  if (m && ctx.has('k' + m[1])) return 'k' + m[1];
  return byUpper(ctx, base);
}

/** USDT perp symbol (SOLUSDT, 1000PEPEUSDT) -> Hyperliquid coin, or null if not listed there */
async function coinFor(sym) {
  const ctx = await contexts();
  return canonical(ctx, String(sym).replace(/USDT$/, ''));
}

const SRC = 'Hyperliquid info API (public chain state)';
const { CORE } = require('../universe');
const badSymbol = (sym) => Object.assign(new Error(`unsupported symbol "${String(sym).slice(0, 40)}": Hyperliquid lists no perp for it. Any Hyperliquid perp works, e.g. ${CORE.join(', ')}; a 1000x bundle is named 1000PEPEUSDT.`), { kind: 'bad_request' });
const sourceDown = (e) => Object.assign(new Error(`Hyperliquid read failed (${String(e && e.message || e).slice(0, 120)}). Not charged.`), { status: 503 });
const NOT_LISTED = (sym) => ({ listed: false, reason: `Hyperliquid lists no perp for ${sym}`, source: SRC });
const unavailable = (e) => ({ available: false, reason: `Hyperliquid read failed: ${String(e && e.message || e).slice(0, 120)}`, source: SRC });

/** strict: { coin, ctx } for a USDT-style symbol. Throws 400 (Hyperliquid lists no such perp) or 503 (it could not be asked). */
async function resolve(sym) {
  let ctx;
  try { ctx = await contexts(); } catch (e) { throw sourceDown(e); }
  const coin = canonical(ctx, String(sym).replace(/USDT$/, ''));
  if (!coin) throw badSymbol(sym);
  return { coin, ctx: ctx.get(coin) };
}

/** strict block(): fn(coin, ctx) IS the answer, so its failure is a 503, never a note inside a 200 */
async function only(sym, fn) {
  const { coin, ctx } = await resolve(sym);
  try { return { coin, ...(await fn(coin, ctx)), source: SRC }; } catch (e) {
    if (e && (e.kind === 'bad_request' || e.status === 503)) throw e;
    throw sourceDown(e);
  }
}

/** run fn(coin, ctx) for a USDT perp symbol; never throws */
async function block(sym, fn) {
  try {
    const coin = await coinFor(sym);
    if (!coin) return NOT_LISTED(sym);
    const ctx = (await contexts()).get(coin);
    return { coin, ...(await fn(coin, ctx)), source: SRC };
  } catch (e) { return unavailable(e); }
}

const l2Book = (coin) => cached(`hl:l2:${coin}`, 5_000, () => info({ type: 'l2Book', coin }));
const candles = (coin, interval, days) => cached(`hl:candles:${coin}:${interval}:${days}`, 300_000, () => {
  const now = Date.now();
  return info({ type: 'candleSnapshot', req: { coin, interval, startTime: now - days * 86_400_000, endTime: now } });
});
const fundingHistory = (coin, hours) => cached(`hl:fh:${coin}:${hours}`, 300_000, () => info({ type: 'fundingHistory', coin, startTime: Date.now() - (hours + 1) * 3_600_000 }));

/** whole-universe rows for the screeners: funding at 8h, annualised, 24h change, OI, volume */
async function universe({ minVolumeUsd = 0 } = {}) {
  const ctx = await contexts();
  return [...ctx.values()].filter((c) => c.funding_1h != null && (c.volume_24h_usd || 0) >= minVolumeUsd).map((c) => ({
    coin: c.coin, price: c.mark,
    funding_rate_raw: c.funding_1h, funding_interval_hours: 1, funding_rate_8h: c.funding_1h * 8,
    annualized_pct: Number((c.funding_1h * 24 * 365 * 100).toFixed(2)),
    change_24h_pct: c.prev_day ? Number((((c.mark - c.prev_day) / c.prev_day) * 100).toFixed(2)) : null,
    oi_usd: c.oi_usd, volume_24h_usd: c.volume_24h_usd,
  }));
}

module.exports = { contexts, coinFor, block, resolve, only, l2Book, candles, fundingHistory, universe, sourceDown, badSymbol, SRC, _canonical: canonical };
