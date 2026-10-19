// tools/liqfeed.js — /api/liq-feed (task #90): cross-venue liquidation pressure in 5-second buckets, computed by AgentFeed.
//
// WHAT IT IS. For each symbol and each closed 5-second bucket that held a liquidation: the long and the short USD liquidated,
// their base quantity and VWAP, the dominant side, and the pressure against the symbol's own baseline. The numbers combine every
// venue our recording covers into ONE figure per symbol per side. WHAT IT IS NOT. It serves no individual print, no venue split
// and no exchange name anywhere (decision of 15 Oct 2026, docs/SOURCES.md C7): USD and quantity are rounded to 2 significant
// figures and the VWAP to 3, so a lone print in a quiet bucket cannot be read back; the print COUNT is not returned.
//
// STREAM TIME. A bucket's time `t` is stream time, not event time: rows are read in id (arrival) order and each one is placed by
// a clock that only moves forward, clock = max(clock, row.ts). Measured 15 Oct on the live tape: 7.9% of rows (5.4% of USD) from
// one venue carry an event time more than 10 s behind the stream, p50 4.7 minutes and up to 3 hours. Bucketing by event time
// would put them in buckets a poller had already passed and drop them. In stream time they are counted in the bucket in which
// our recording learned of them, so nothing is dropped, and a bucket that the clock has left can never receive another row.
//
// CURSOR. `next` is "<F>.<id>": F is the start (ms, a multiple of 5000) of the first bucket not yet served and id the last row
// consumed. A call reads the rows after id, in order, and serves every bucket that is at least SETTLE_MS old; rows of a younger
// bucket are left for the next call (the cursor stops just before them). Rows can never fall before F, so every served bucket
// is final. A poller that always sends back `next` sees each row exactly once. Cut at 500 rows or at the scan cap, the answer
// ends on a bucket boundary and says has_more.
//
// One call per CALLER_INTERVAL_MS (one bucket, 5 s) per caller, PASS_INTERVAL_MS (10 s) for a pass key, unless the previous answer said has_more:
// that is catch-up. The horizon below moves in whole BUCKET_MS steps, so a call less than one bucket after the last cannot carry a new bucket and
// billing it would sell an empty answer; from one bucket on, every call has at least one new settled bucket.
// R15d/R15e: over MCP the caller is on the same clock as over REST: mcp.js hands get_liq_feed { caller: { key, pass } } with the REST rail's own
// 'key:<prefix>' for a key (pass or pack: ONE clock across REST and MCP, has_more included) or 'wallet:<payer>' for an x402 payer once the
// facilitator has verified the payment. An x402 payer is keyed by IP over REST and by wallet over MCP, so those two do not share a clock.
// Everything that is refused here is a 4xx or 503, so the call is never billed (lib/tool.js, lib/keys.js).
'use strict';
const Database = require('better-sqlite3');
const { CORE } = require('../universe');

const BUCKET_MS = 5000;
const SETTLE_MS = 10000;
const MAX_SYMBOLS = 20;
const MAX_ROWS = 500;
const SCAN_CAP = 50000;          // raw tape rows read per call (all symbols: the clock needs them all); cut at a bucket boundary
const LOOKBACK_MS = 24 * 3600_000;
const PASS_INTERVAL_MS = 10_000;         // a pass key (flat fee): one call every 10 s, REST and MCP on one clock
const CALLER_INTERVAL_MS = BUCKET_MS;    // an x402 payer or a prepaid pack key (pays per call): one call every bucket
const MIN_INTERVAL_MS = PASS_INTERVAL_MS;   // the older name, kept for callers that import it
/** The sentence the docs, the 402 note aside, use for the pace: one place, so openapi, llms.txt, SKILL.md and the MCP tool description agree. */
const PACE_SENTENCE = `Calls are paced per caller: one every ${CALLER_INTERVAL_MS / 1000} seconds (one bucket) for an x402 payer or a prepaid pack key, one every ${PASS_INTERVAL_MS / 1000} seconds for a pass key, except while an answer says has_more; a call that comes too early is a 429 with Retry-After and is never billed.`;
const STALE_S = 30 * 60;         // the bound every tape route uses
const BASE_FLOOR_USD_H = 5000;   // the floor /api/signal-board puts under a quiet coin's hourly baseline (tools/signals.js Z_FLOOR_USD)
const DOMINANT_SHARE = 0.6;
const DEFAULT_START_MS = 120_000;   // neither since nor next: begin 2 minutes back, so a first call shows something and a bot has context

const DB_PATH = () => process.env.LIQ_DB || '/opt/agentfeed/liquidations.db';
let _db = null;
const getDb = () => (_db || (_db = new Database(DB_PATH(), { readonly: true, fileMustExist: true })));

const bad = (msg, extra = {}) => Object.assign(new Error(msg), { kind: 'bad_request', ...extra });

/** n to `digits` significant figures, as a number (0 stays 0). */
const sig = (x, digits) => (Number.isFinite(x) && x !== 0 ? Number(Number(x).toPrecision(digits)) : 0);

function parseSymbols(raw, deps) {
  if (raw == null || String(raw).trim() === '') return [...CORE];
  const normSym = deps.normSym || require('./derivs')._normSym;
  const tapeSymbol = deps.tapeSymbol || require('./liqdb').tapeSymbol;
  const out = [];
  for (const item of String(raw).split(',')) {
    const s = item.trim();
    if (!s) continue;
    const sym = normSym(s.replace(/[-/_]/g, ''));            // BTC-USDT, BTC/USDT, BTC, btcusdt, kPEPE all resolve; anything else is a 400
    if (!out.includes(sym)) out.push(sym);
    if (out.length > MAX_SYMBOLS) throw bad(`symbols: at most ${MAX_SYMBOLS} per call`);
  }
  if (!out.length) throw bad('symbols is empty: send a comma list such as BTC,ETH,SOL, or leave it out for SOL, BTC, ETH, XRP and DOGE');
  return out.map((sym) => tapeSymbol(sym));                  // a symbol the tape has never recorded is a 400, checked after the cheap checks
}

/** -> { F, lastId }: the first bucket to serve and the last row already consumed. */
function parseStart(q, now, horizon, db) {
  const given = (v) => v != null && String(v).trim() !== '';
  const maxId = (db.prepare('SELECT MAX(id) AS m FROM liquidations').get() || {}).m || 0;
  if (given(q.next)) {
    const m = /^(\d{1,15})\.(\d{1,12})$/.exec(String(q.next).trim());
    if (!m) throw bad('next must be the `next` value a previous answer returned');
    const F = Number(m[1]); const lastId = Number(m[2]);
    if (F % BUCKET_MS !== 0) throw bad('next must be the `next` value a previous answer returned');
    if (F > horizon + BUCKET_MS || lastId > maxId) throw bad('next is from the future or from another tape: send the `next` value of the last answer');
    if (F < now - LOOKBACK_MS) throw bad('next is older than the 24 h this route serves; start again with since=<ms>');
    return { F, lastId };
  }
  let since;
  if (given(q.since)) {
    const s = String(q.since).trim();
    if (!/^\d{1,15}$/.test(s)) throw bad('since must be a time in milliseconds since the epoch, e.g. since=1792064900000');
    since = Number(s);
    if (since > now) throw bad('since is in the future');
    if (since < now - LOOKBACK_MS) throw bad('since is older than the 24 h this route serves');
  } else {
    since = horizon - DEFAULT_START_MS;
  }
  const F = Math.floor(since / BUCKET_MS) * BUCKET_MS;
  const first = (db.prepare('SELECT MIN(id) AS m FROM liquidations WHERE ts >= ?').get(F) || {}).m;
  return { F, lastId: (first == null ? maxId + 1 : first) - 1 };
}

const callers = new Map();       // caller key -> { at, more }

/**
 * Who is calling, and how often they may. -> { key, ms, what } or null (an MCP caller with no identity: ungated).
 *   REST   req.keyPaid { prefix, pass } -> 'key:<prefix>'; no key -> 'ip:<address>' (an x402 payer)
 *   MCP    req.caller { key, pass } handed by mcp.js: 'key:<prefix>' (the REST rail's own string, so one key has ONE clock across the two
 *          surfaces) or 'wallet:<payer>' for an x402 caller, known once the payment is verified
 * A pass key (the 30-day bot pass, the 24-hour day pass) pays a flat fee: one call every PASS_INTERVAL_MS. Everyone else pays for every call:
 * one call every CALLER_INTERVAL_MS, one bucket, so a billed call always has a new settled bucket to carry (the horizon moves in BUCKET_MS steps).
 */
function callerOf(req) {
  if (!req) return null;                                                           // MCP without an identity: its own per-key limit (120 a minute) applies
  const named = (key, pass) => ({ key, ms: pass ? PASS_INTERVAL_MS : CALLER_INTERVAL_MS, what: key.startsWith('key:') ? 'key' : key.startsWith('wallet:') ? 'payer' : 'caller' });
  if (req.caller && req.caller.key) return named(req.caller.key, !!req.caller.pass);
  if (req.keyPaid) return named(`key:${req.keyPaid.prefix}`, !!req.keyPaid.pass);
  return named(`ip:${req.callerIp || (req.headers && req.headers['cf-connecting-ip']) || 'unknown'}`, false);
}
const callerKey = (req) => { const c = callerOf(req); return c ? c.key : null; };
function gate(c, now) {
  if (!c) return;
  const prev = callers.get(c.key);
  if (prev && !prev.more && now - prev.at < c.ms) {
    const wait = Math.ceil((c.ms - (now - prev.at)) / 1000);
    throw bad(`liq-feed: one call every ${c.ms / 1000} s per ${c.what} (more only while an answer says has_more). Retry in ${wait} s. Not charged.`, { status: 429, retryAfter: wait });
  }
}
function remember(c, now, more) {
  if (!c) return;
  callers.set(c.key, { at: now, more: !!more });
  if (callers.size > 5000) for (const [k, v] of callers) if (now - v.at > 60_000) callers.delete(k);
}

function assertFresh(db, now) {
  const r = db.prepare('SELECT MAX(ts) AS t FROM liquidations').get();
  const age = r && r.t ? Math.round((now - r.t) / 1000) : null;
  if (age == null || age > STALE_S) {
    throw Object.assign(new Error(age == null ? 'the liquidation tape is empty. Not charged.' : `the liquidation tape is ${age}s old, past the ${STALE_S}s freshness bound. Not charged.`), { status: 503 });
  }
}

/**
 * p: { symbols, since, next } (strings or numbers). req: the HTTP request (REST) or undefined (MCP).
 * deps (tests): { db, now: () => ms, baseline: () => Map(sym -> { median }), normSym, tapeSymbol, scanCap, maxRows, unrounded }.
 */
function getLiqFeed(p = {}, req, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const db = deps.db || getDb();
  const caller = callerOf(req);
  const scanCap = deps.scanCap || SCAN_CAP; const maxRows = deps.maxRows || MAX_ROWS;
  const raw = !!deps.unrounded;                                                 // tests only: skip the rounding to check sums exactly
  gate(caller, now);
  assertFresh(db, now);
  const horizon = Math.floor((now - SETTLE_MS) / BUCKET_MS) * BUCKET_MS;       // buckets that start before this are old enough to serve
  const symbols = parseSymbols(p.symbols, deps);
  const { F, lastId } = parseStart(p, now, horizon, db);
  const wanted = new Set(symbols);

  // 1. read the rows after the cursor in id order and place each by the stream clock
  const rows = db.prepare('SELECT id, ts, symbol, side, size, usd FROM liquidations WHERE id > ? ORDER BY id LIMIT ?').all(lastId, scanCap + 1);
  const truncated = rows.length > scanCap;
  const buckets = [];                       // ascending: { b, lastRowId, syms: Map(symbol -> { Buy, Sell }) }
  let clock = F;
  let cur = null;
  let consumedId = lastId;
  let stoppedOpen = false;
  for (let i = 0; i < (truncated ? scanCap : rows.length); i++) {
    const r = rows[i];
    const ts = Math.min(r.ts, now);                                              // a stamp ahead of the box clock cannot push the stream clock into the future
    if (ts > clock) clock = ts;
    const b = Math.floor(clock / BUCKET_MS) * BUCKET_MS;
    if (b >= horizon) { stoppedOpen = true; break; }                              // this bucket is still open: leave it and everything after for the next call
    if (!cur || cur.b !== b) { cur = { b, lastRowId: r.id, syms: new Map() }; buckets.push(cur); }
    cur.lastRowId = r.id;
    consumedId = r.id;
    if (wanted.has(r.symbol)) {
      let s = cur.syms.get(r.symbol); if (!s) cur.syms.set(r.symbol, (s = { Buy: { usd: 0, qty: 0 }, Sell: { usd: 0, qty: 0 } }));
      const side = r.side === 'Sell' ? 'Sell' : 'Buy';                            // Buy = long positions liquidated (the tape's convention)
      s[side].usd += r.usd; s[side].qty += r.size;
    }
  }

  // 2. where the cursor ends: at the horizon if everything readable was consumed or the next bucket is open; at a bucket
  //    boundary if the scan cap cut the read (the last bucket may be incomplete, so it is dropped and read again)
  let nextF = Math.max(F, horizon);
  let nextId = consumedId;
  let hasMore = false;
  if (truncated && !stoppedOpen) {
    if (buckets.length < 2) throw bad('liq-feed: too many liquidations in one 5-second bucket to page', { status: 503 });
    const dropped = buckets.pop();
    nextF = dropped.b;
    nextId = buckets[buckets.length - 1].lastRowId;
    hasMore = true;
  }

  // 3. the answer rows, whole buckets only, at most maxRows
  const baseline = (() => { try { return (deps.baseline || require('./signals').liqBaseline)(); } catch { return null; } })();
  const side = (x) => (x.usd > 0 ? { usd: raw ? x.usd : sig(x.usd, 2), qty: raw ? x.qty : sig(x.qty, 2), vwap: raw ? x.usd / x.qty : sig(x.usd / x.qty, 3) } : null);
  const out = [];
  for (let i = 0; i < buckets.length; i++) {
    const bk = buckets[i];
    const rowsOut = [];
    for (const sym of symbols) {
      const s = bk.syms.get(sym);
      if (!s) continue;
      const longs = s.Buy; const shorts = s.Sell;
      const total = longs.usd + shorts.usd;
      const share = total > 0 ? longs.usd / total : 0.5;
      const base = baseline && baseline.get(sym);          // a symbol with no print in 7 days has no entry: its baseline is the floor
      const perBucket = baseline ? Math.max((base && base.median) || 0, BASE_FLOOR_USD_H) / (3600_000 / BUCKET_MS) : null;
      rowsOut.push({
        t: bk.b, symbol: sym, longs: side(longs), shorts: side(shorts),
        dominant: share >= DOMINANT_SHARE ? 'longs' : (1 - share) >= DOMINANT_SHARE ? 'shorts' : 'balanced',
        pressure: perBucket ? (raw ? total / perBucket : sig(total / perBucket, 2)) : null,
      });
    }
    if (out.length && out.length + rowsOut.length > maxRows) {                    // whole buckets only
      nextF = bk.b;
      nextId = buckets[i - 1].lastRowId;
      hasMore = true;
      break;
    }
    out.push(...rowsOut);
  }
  remember(caller, now, hasMore);
  return {
    source: 'cross-venue liquidation pressure, computed by AgentFeed',
    bucket_s: BUCKET_MS / 1000,
    settle_s: SETTLE_MS / 1000,
    as_of: horizon,
    symbols,
    count: out.length,
    has_more: hasMore,
    next: `${nextF}.${nextId}`,
    buckets: out,
    basis: {
      t: 'start of the 5-second bucket in stream time: a liquidation counts in the bucket in which our recording learned of it',
      longs: 'long positions liquidated in the bucket (USD, base quantity, VWAP across venues)',
      shorts: 'short positions liquidated in the bucket',
      dominant: 'the side holding at least 60% of the bucket USD, else balanced',
      pressure: "the bucket's total USD divided by the symbol's own typical USD per 5 seconds (its median hour over the last 7 days, floored at $5,000 an hour, spread over 720 buckets)",
      rounding: 'USD, quantity and pressure to 2 significant figures, VWAP to 3; no count of prints',
    },
  };
}

module.exports = { getLiqFeed, BUCKET_MS, SETTLE_MS, MAX_ROWS, MIN_INTERVAL_MS, PASS_INTERVAL_MS, CALLER_INTERVAL_MS, PACE_SENTENCE, _callers: callers, _callerKey: callerKey, _callerOf: callerOf };
