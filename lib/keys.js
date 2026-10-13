// lib/keys.js — prepaid API keys (R9 K1, K2): bought with one x402 payment, spent per call at the high-frequency price.
//
// WHY. Bots that can set a header but cannot pay x402 (NOFX External Data Sources, Freqtrade, n8n, plain scripts, a
// gateway such as claw402 that lists `upstream_type: api_key` providers) could not use AgentFeed. A key is a balance
// bought once, on any exact rail, and drawn down per call at hfUsd(route price): half the list price, minimum $0.0005.
//
// THE KEY. `afk_` + base58 of 32 random bytes. Only sha256(key) is stored (api_keys.key_hash); the key itself is in
// exactly one place, the body of the purchase response, and never in a calls row, a log line or an error message.
// The header is deleted from the request as soon as it is read, so no later middleware can log it either.
// A buyer may instead generate the key locally and buy with `key_hash` = sha256 hex of it: the server registers the
// hash and never sees the key before its first use, and a connection that drops after settlement loses nothing.
//
// PURCHASE ORDERING, measured against @x402/express 2.28 (dist/cjs/index.js, payment-verified branch), lib/x402v1.js
// hold() and mpp/tempo.js hold(): all three BUFFER the handler's response, settle only when it is < 400, and release
// the body only after settlement succeeded. A failed settlement discards the body (the buyer never sees the key); a
// handler >= 400 cancels the settlement (the buyer is never charged). So:
//   - the handler inserts the row as 'pending' and returns the key (buffered, not yet sent);
//   - the row turns 'active' at the moment the settlement is PRESENT: a PAYMENT-RESPONSE header with success:true
//     being set on this response (x402 v2 and v1), or req.mppSettlement being assigned (MPP tempo). Hooked at the
//     source rather than on 'finish', so a client that disconnects while settlement runs still gets its credit;
//   - on 'finish' a row that never saw its settlement is deleted at once (settlement failed or the handler failed);
//     a pending row older than 10 minutes is deleted by the sweep (a connection that closed mid-settlement).
// A top-up changes nothing until its settlement is present, then adds its credit in one UPDATE.
//
// CHARGING A CALL (makeCharge). Atomic reserve before the handler:
//   UPDATE api_keys SET balance_micro = balance_micro - ? WHERE key_hash = ? AND status = 'active' AND balance_micro >= ?
// no row changed = 402 JSON. On 'finish': status >= 400 refunds the reserve (a 400, 404 or 503 is never billed, the
// same rule as x402); < 400 counts the call and writes one calls row, status 'key'. A response that never finished
// (the caller hung up) is refunded. Revenue is unchanged: settled payments, status 'paid', which includes the key
// purchases themselves; a 'key' row is consumption of credit already counted.
'use strict';
const crypto = require('crypto');

const PREFIX = 'afk_';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const KEY_RE = /^afk_[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^[1-9A-HJ-NP-Za-km-z]{8}$/;
const PENDING_TTL_MS = 10 * 60_000;
const DEFAULT_RATE = 120;
const BUY_PATH = '/api/keys/buy-5';
const TOPUP_PATH = '/api/keys/topup-5';

const SCHEMA = `CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  prefix TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
  balance_micro INTEGER NOT NULL DEFAULT 0,
  sold_micro INTEGER NOT NULL DEFAULT 0,
  spent_micro INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_used INTEGER,
  buyer TEXT,
  purchase_tx TEXT,
  rate_per_min INTEGER NOT NULL DEFAULT ${DEFAULT_RATE},
  label TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS api_keys_status_created ON api_keys(status, created);`;

function base58(buf) {
  let x = BigInt('0x' + (buf.toString('hex') || '0'));
  let out = '';
  while (x > 0n) { out = B58[Number(x % 58n)] + out; x /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}
const newKey = () => PREFIX + base58(crypto.randomBytes(32));
const hashKey = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
const prefixOf = (key) => String(key).slice(PREFIX.length, PREFIX.length + 8);
const toMicro = (usd) => Math.round(Number(usd) * 1e6);
const toUsd = (micro) => (micro == null ? null : Math.round(Number(micro)) / 1e6);

/** The key a request presents, or null; { malformed: true } for a header that names our scheme but is not a key. */
function presentedKey(req) {
  const h = req.headers || {};
  let raw = h['x-agentfeed-key'];
  if (Array.isArray(raw)) raw = raw[0];
  let from = 'x-agentfeed-key';
  if (raw == null || String(raw).trim() === '') {
    const m = /^\s*bearer\s+(\S+)\s*$/i.exec(String(h.authorization || ''));
    if (!m || !m[1].startsWith(PREFIX)) return null; // a Bearer token that is not ours is not our business
    raw = m[1];
    from = 'authorization';
  }
  const key = String(raw).trim();
  return KEY_RE.test(key) ? { key, from } : { malformed: true, from };
}

function makeKeyStore(db, { now = () => Date.now() } = {}) {
  db.exec(SCHEMA);
  const q = {
    get: db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),
    insert: db.prepare(`INSERT INTO api_keys (key_hash, prefix, status, balance_micro, sold_micro, created, rate_per_min, label, buyer)
                        VALUES (@key_hash, @prefix, @status, @balance_micro, @sold_micro, @created, @rate_per_min, @label, @buyer)`),
    activate: db.prepare("UPDATE api_keys SET status = 'active', buyer = ?, purchase_tx = ? WHERE key_hash = ? AND status = 'pending'"),
    dropPending: db.prepare("DELETE FROM api_keys WHERE key_hash = ? AND status = 'pending'"),
    sweep: db.prepare("DELETE FROM api_keys WHERE status = 'pending' AND created < ?"),
    credit: db.prepare("UPDATE api_keys SET balance_micro = balance_micro + ?, sold_micro = sold_micro + ? WHERE key_hash = ? AND status IN ('active', 'revoked')"),
    reserve: db.prepare("UPDATE api_keys SET balance_micro = balance_micro - ? WHERE key_hash = ? AND status = 'active' AND balance_micro >= ?"),
    refund: db.prepare('UPDATE api_keys SET balance_micro = balance_micro + ? WHERE key_hash = ?'),
    commit: db.prepare('UPDATE api_keys SET calls = calls + 1, spent_micro = spent_micro + ?, last_used = ? WHERE key_hash = ?'),
    learnPrefix: db.prepare('UPDATE api_keys SET prefix = ? WHERE key_hash = ? AND (prefix IS NULL OR prefix <> ?)'),
    byPrefix: db.prepare("SELECT * FROM api_keys WHERE prefix = ? OR key_hash LIKE ? || '%' ORDER BY created"),
    list: db.prepare('SELECT * FROM api_keys ORDER BY created'),
    setStatus: db.prepare('UPDATE api_keys SET status = ? WHERE key_hash = ?'),
    setRate: db.prepare('UPDATE api_keys SET rate_per_min = ? WHERE key_hash = ?'),
  };
  return {
    db,
    get: (hash) => q.get.get(hash) || null,
    /** a pending row; throws on a duplicate hash (the handler turns that into a 400, which cancels the settlement) */
    createPending({ hash, prefix, creditMicro }) {
      q.insert.run({ key_hash: hash, prefix: prefix || null, status: 'pending', balance_micro: creditMicro, sold_micro: creditMicro, created: now(), rate_per_min: DEFAULT_RATE, label: null, buyer: null });
    },
    activate: (hash, buyer, tx) => q.activate.run(buyer || null, tx || null, hash).changes === 1,
    dropPending: (hash) => q.dropPending.run(hash).changes,
    sweep: (at = now()) => q.sweep.run(at - PENDING_TTL_MS).changes,
    credit: (hash, micro) => q.credit.run(micro, micro, hash).changes === 1,
    reserve: (hash, micro) => q.reserve.run(micro, hash, micro).changes === 1,
    refund: (hash, micro) => q.refund.run(micro, hash).changes,
    commit: (hash, micro) => q.commit.run(micro, now(), hash).changes,
    learnPrefix: (hash, prefix) => q.learnPrefix.run(prefix, hash, prefix).changes,
    find: (p) => q.byPrefix.all(String(p), String(p).toLowerCase()),
    list: () => q.list.all(),
    setStatus: (hash, s) => q.setStatus.run(s, hash).changes,
    setRate: (hash, n) => q.setRate.run(n, hash).changes,
    /** a comp or partner key, active at once; returns the key (the caller prints it once and keeps nothing) */
    grant(usd, label) {
      const key = newKey();
      q.insert.run({ key_hash: hashKey(key), prefix: prefixOf(key), status: 'active', balance_micro: toMicro(usd), sold_micro: 0, created: now(), rate_per_min: DEFAULT_RATE, label: label || null, buyer: 'grant' });
      return key;
    },
  };
}

/** Public view of a row; never the hash in full, never the key. */
function publicView(row) {
  return {
    prefix: row.prefix || null,
    balance_usd: toUsd(row.balance_micro),
    calls: row.calls,
    spent_usd: toUsd(row.spent_micro),
    last_used: row.last_used ? new Date(row.last_used).toISOString() : null,
    rate_per_min: row.rate_per_min,
    status: row.status,
  };
}

/**
 * Calls cb({ payer, transaction, network }) once, at the moment a successful settlement becomes present on this
 * response: a PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header carrying success:true (x402 v2 and v1), or an assignment
 * to req.mppSettlement (MPP tempo, mpp/tempo.js). Install it inside the handler: every payment layer sets these
 * after the handler returned and before the buffered body is released.
 */
function onSettled(req, res, cb) {
  let fired = false;
  const fire = (s) => { if (fired) return; fired = true; try { cb(s || {}); } catch (e) { console.error('[keys] settlement hook failed:', e.message); } };
  const set = res.setHeader;
  res.setHeader = function (name, value) {
    const r = set.apply(this, arguments);
    const n = String(name).toLowerCase();
    if (n === 'payment-response' || n === 'x-payment-response') {
      try {
        const s = JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
        if (s && s.success === true) fire({ payer: s.payer || null, transaction: s.transaction || null, network: s.network || null });
      } catch { /* not a settlement header we can read: no activation */ }
    }
    return r;
  };
  let mpp = req.mppSettlement;
  if (mpp) fire({ payer: mpp.payer, transaction: mpp.transaction });
  Object.defineProperty(req, 'mppSettlement', {
    configurable: true, enumerable: true,
    get: () => mpp,
    set: (v) => { mpp = v; if (v) fire({ payer: v.payer || null, transaction: v.transaction || null, network: v.method || null }); },
  });
  return { get fired() { return fired; } };
}

/**
 * Everything server.js and expansion.js wire in Phase 2.
 * deps: { db, PRICES, logCall, hfUsd, paymentsOn, now? }
 */
function makeKeys({ db, PRICES, logCall, hfUsd, paymentsOn = true, now = () => Date.now() }) {
  const store = makeKeyStore(db, { now });
  const KEY_ROUTE = /^\/api\/keys\//;
  // path -> { pattern, tool, usd }, with the same pattern-to-regex rule as server.js PRICED_PATHS (HEAD guard)
  const PRICED = Object.entries(PRICES)
    .filter(([pattern]) => pattern.startsWith('GET ') && !KEY_ROUTE.test(pattern.slice(4)))
    .map(([pattern, p]) => ({ re: new RegExp('^' + pattern.slice(4).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+') + '$'), pattern, tool: p.tool, usd: p.usd }));
  const pricedFor = (path) => PRICED.find((r) => r.re.test(path)) || null;

  const sweepTimer = setInterval(() => { try { store.sweep(); } catch (e) { console.error('[keys] sweep failed:', e.message); } }, 60_000);
  if (sweepTimer.unref) sweepTimer.unref();

  // ---- 1. identify: before the IP limiter. Reads and REMOVES the key header, looks the hash up (no reserve).
  // A valid active key gets its own per-key bucket instead of the IP bucket (server.js skips req.afKey.active).
  const buckets = new Map();
  const bucketTimer = setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.windowStart > 120_000) buckets.delete(k); }, 120_000);
  if (bucketTimer.unref) bucketTimer.unref();
  function identify(req, res, next) {
    const p = presentedKey(req);
    if (!p) return next();
    delete req.headers['x-agentfeed-key'];
    if (p.from === 'authorization') delete req.headers.authorization; // a Bearer key never reaches the Payment-alias middlewares
    if (p.malformed) { req.afKey = { presented: true, active: false, row: null, hash: null }; return next(); }
    const hash = hashKey(p.key);
    const row = store.get(hash);
    if (row && row.prefix !== prefixOf(p.key)) store.learnPrefix(hash, prefixOf(p.key)); // a key_hash purchase meets its key
    const active = !!row && row.status === 'active';
    req.afKey = { presented: true, active, row: row ? { ...row, prefix: prefixOf(p.key) } : null, hash };
    if (!active) return next();
    const metered = req.method === 'GET' || (req.method === 'POST' && req.path === '/mcp');
    if (!metered) return next();
    const t = now();
    let b = buckets.get(hash);
    if (!b || t - b.windowStart > 60_000) { b = { windowStart: t, n: 0, logged: false }; buckets.set(hash, b); }
    b.n++;
    const limit = row.rate_per_min || DEFAULT_RATE;
    if (b.n > limit) {
      const retryAfter = Math.max(1, Math.ceil((b.windowStart + 60_000 - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      if (!b.logged) {
        b.logged = true;
        logCall({ tool: 'rate_limited', status: 'bad_request', ip: req.callerIp || req.headers['cf-connecting-ip'] || null, payer_wallet: `key:${req.afKey.row.prefix}`,
          error_msg: `key rate limit: ${limit} req/min exceeded (retry after ${retryAfter}s)`, req_path: req.path, user_agent: req.headers['user-agent'], method: req.method });
      }
      return res.status(429).json({ error: `key rate limit: ${limit} req/min`, retry_after: retryAfter });
    }
    return next();
  }

  // ---- 2. purchase guard: before every payment layer. Refusals that must come BEFORE anyone pays.
  function purchaseGuard(req, res, next) {
    if (req.method !== 'GET' || !KEY_ROUTE.test(req.path) || req.path === '/api/keys/balance') return next();
    if (!paymentsOn) return res.status(503).json({ error: 'key sales need the payment layer, which is off on this instance' });
    if (/^\/api\/keys\/buy-/.test(req.path)) {
      const kh = req.query && req.query.key_hash;
      if (kh != null && kh !== '') {
        if (typeof kh !== 'string' || !HASH_RE.test(kh.toLowerCase())) return res.status(400).json({ error: 'key_hash must be 64 hex characters: the sha256 of a key you generated as afk_ + base58 of 32 random bytes' });
        if (store.get(kh.toLowerCase())) return res.status(409).json({ error: 'this key_hash is already registered; generate a new key' });
      }
      const pf = req.query && req.query.prefix;
      if (pf != null && pf !== '' && (typeof pf !== 'string' || !PREFIX_RE.test(pf))) return res.status(400).json({ error: 'prefix must be the 8 characters after afk_ in your key' });
      return next();
    }
    if (/^\/api\/keys\/topup-/.test(req.path)) {
      if (!req.afKey || !req.afKey.row || req.afKey.row.status === 'pending') return res.status(401).json({ error: 'a top-up needs the key it credits: send X-AgentFeed-Key: afk_...', buy: BUY_PATH });
      if (req.afKey.row.status === 'revoked') return res.status(401).json({ error: 'this key is revoked', buy: BUY_PATH });
      return next();
    }
    return next();
  }

  // ---- 3. charge: after the HEAD guard, GET-only, the https fix and query canonicalisation; before the refusal
  // recorder, demand, the alias middlewares, x402 v1, tempo, MPP and the x402 gate (all of which skip req.keyPaid).
  function charge(req, res, next) {
    if (!req.afKey || !req.afKey.presented) return next();
    if (req.method !== 'GET' || KEY_ROUTE.test(req.path)) return next();
    const priced = pricedFor(req.path);
    if (!priced) return next(); // a key on a free route is ignored
    if (req.headOnly) return next(); // HEAD: no body, no charge; the x402 layer answers its plain challenge
    if (!req.afKey.active) {
      const st = req.afKey.row ? req.afKey.row.status : null;
      return res.status(401).json({ error: st === 'revoked' ? 'this key is revoked' : st === 'pending' ? 'this key\'s purchase has not settled' : 'unknown key', buy: BUY_PATH });
    }
    const usd = hfUsd(priced.usd);
    const micro = toMicro(usd);
    const hash = req.afKey.hash;
    if (!store.reserve(hash, micro)) {
      const row = store.get(hash);
      return res.status(402).json({ error: 'key balance too low', balance_usd: toUsd(row ? row.balance_micro : 0), price_usd: usd, topup: TOPUP_PATH });
    }
    for (const h of ['payment-signature', 'x-payment', 'payment-authorization']) delete req.headers[h]; // one payment per call
    req.keyPaid = { prefix: req.afKey.row.prefix, micro, usd, hash, tool: priced.tool };
    const t0 = now();
    let done = false;
    const settle = (finished) => {
      if (done) return;
      done = true;
      if (!finished || res.statusCode >= 400) { store.refund(hash, micro); return; }
      store.commit(hash, micro);
      logCall({ tool: priced.tool, status: 'key', payer_wallet: `key:${req.keyPaid.prefix}`, tx_sig: null, amount_usdc: usd, latency_ms: now() - t0, ip: req.callerIp,
        ...(req.x402OriginalPath ? { req_path: req.x402OriginalPath } : {}) });
    };
    res.on('finish', () => settle(true));
    res.on('close', () => settle(res.writableFinished));
    return next();
  }

  // ---- 4. the purchase and top-up handlers (EXP run functions; Phase 2 passes req as the second argument)
  function buy(args, req, creditUsd) {
    if (!paymentsOn) throw Object.assign(new Error('key sales need the payment layer'), { status: 503 });
    const res = req && req.res;
    if (!res) throw new Error('keys: buy needs the HTTP response (REST only)');
    const creditMicro = toMicro(creditUsd);
    let key = null;
    let hash;
    let prefix;
    const kh = args.key_hash == null || args.key_hash === '' ? null : String(args.key_hash).toLowerCase();
    if (kh) {
      if (!HASH_RE.test(kh)) throw Object.assign(new Error('key_hash must be 64 hex characters'), { kind: 'bad_request' });
      hash = kh;
      prefix = args.prefix && PREFIX_RE.test(String(args.prefix)) ? String(args.prefix) : null;
    } else {
      key = newKey();
      hash = hashKey(key);
      prefix = prefixOf(key);
    }
    try {
      store.createPending({ hash, prefix, creditMicro });
    } catch (e) {
      // a duplicate that raced past the guard: 400 cancels the settlement, so nobody is charged
      throw Object.assign(new Error(/UNIQUE|PRIMARY/i.test(e.message) ? 'this key_hash is already registered; generate a new key' : 'the key could not be created'), { kind: 'bad_request' });
    }
    const hook = onSettled(req, res, (s) => { store.activate(hash, s.payer, s.transaction); });
    res.on('finish', () => { if (!hook.fired) store.dropPending(hash); });
    const base = {
      prefix,
      credit_usd: toUsd(creditMicro),
      balance_usd: toUsd(creditMicro),
      status: 'active',
      rate_per_min: DEFAULT_RATE,
      use: 'send it on every call as the header X-AgentFeed-Key: <key> (or Authorization: Bearer <key>); each call costs half the route\'s x402 price, minimum $0.0005',
      balance: 'GET /api/keys/balance with the same header (free)',
      topup: 'GET /api/keys/topup-5 or /api/keys/topup-20 with the same header',
      terms: 'usage credit, non-refundable, no expiry; the key is a bearer secret: anyone holding it spends the balance; abuse means revocation',
    };
    if (key) return { key, ...base, note: 'this is the only time the key is shown; it is not stored anywhere on our side, only its sha256' };
    return { ...base, key_hash_prefix: hash.slice(0, 12), note: 'registered by its hash: we never saw your key; it works as soon as this response arrives' };
  }

  function topup(args, req, creditUsd) {
    if (!paymentsOn) throw Object.assign(new Error('key sales need the payment layer'), { status: 503 });
    const res = req && req.res;
    const k = req && req.afKey;
    if (!res || !k || !k.row) throw Object.assign(new Error('a top-up needs the key it credits'), { kind: 'bad_request' });
    const creditMicro = toMicro(creditUsd);
    const hash = k.hash;
    onSettled(req, res, () => { store.credit(hash, creditMicro); });
    return {
      prefix: k.row.prefix,
      credit_usd: toUsd(creditMicro),
      balance_usd: toUsd((store.get(hash) || k.row).balance_micro + creditMicro),
      status: k.row.status,
      note: 'credited when this payment settled; this response is only delivered after it did',
    };
  }

  // ---- 4b. POST /mcp (R9 2a). A key reaches MCP the same way as REST: the X-AgentFeed-Key or Authorization: Bearer
  // header, read and removed by identify() (headers only; a key in a URL or in the JSON-RPC body is never read).
  // mcpWrap(req, def) returns the tool handler wrapper for a request that presented a key, or null when it did not
  // (mcp.js then uses its x402 wrapper). Same rules as charge(): unknown, pending or revoked is refused and never falls
  // through to x402; the price is hfUsd(def.usd), reserved atomically; a tool that throws or answers isError is
  // refunded; a served call counts and writes one calls row, status 'key'. Answers are MCP tool results, so a refusal
  // is an isError result carrying the same JSON the REST rail sends.
  function mcpWrap(req, def) {
    const k = req && req.afKey;
    if (!k || !k.presented || !def.usd) return null;
    const refuse = (body) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] });
    return (handler) => async (args, extra) => {
      if (!k.active) {
        const st = k.row ? k.row.status : null;
        return refuse({ error: st === 'revoked' ? 'this key is revoked' : st === 'pending' ? 'this key\'s purchase has not settled' : 'unknown key', status: 401, buy: BUY_PATH });
      }
      const usd = hfUsd(def.usd);
      const micro = toMicro(usd);
      if (!store.reserve(k.hash, micro)) {
        const row = store.get(k.hash);
        return refuse({ error: 'key balance too low', status: 402, balance_usd: toUsd(row ? row.balance_micro : 0), price_usd: usd, topup: TOPUP_PATH });
      }
      const t0 = now();
      let out;
      try {
        out = await handler(args, extra);
      } catch (e) {
        store.refund(k.hash, micro);
        throw e;
      }
      if (out && out.isError) { store.refund(k.hash, micro); return out; }
      store.commit(k.hash, micro);
      logCall({ tool: def.name, status: 'key', payer_wallet: `key:${k.row.prefix}`, tx_sig: null, amount_usdc: usd, latency_ms: now() - t0, ip: req.callerIp, req_path: '/mcp', method: 'POST' });
      return out;
    };
  }

  // ---- 5. GET /api/keys/balance (free)
  function balance(req, res) {
    const k = req.afKey;
    if (!k || !k.row) return res.status(401).json({ error: k && k.presented ? 'unknown key' : 'send X-AgentFeed-Key: afk_... (or Authorization: Bearer afk_...)', buy: BUY_PATH });
    const row = store.get(k.hash);
    if (!row) return res.status(401).json({ error: 'unknown key', buy: BUY_PATH });
    return res.json(publicView({ ...row, prefix: k.row.prefix }));
  }

  return { store, identify, purchaseGuard, charge, buy, topup, balance, mcpWrap, pricedFor, stop: () => { clearInterval(sweepTimer); clearInterval(bucketTimer); } };
}

module.exports = { makeKeys, makeKeyStore, onSettled, presentedKey, publicView, newKey, hashKey, prefixOf, base58, toMicro, toUsd, KEY_RE, HASH_RE, PENDING_TTL_MS, DEFAULT_RATE, SCHEMA };
