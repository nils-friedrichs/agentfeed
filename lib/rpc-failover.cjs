// rpc-failover.cjs: a counted JSON-RPC client that moves a call to the next endpoint when the primary is out of credits, rate limited or down.
//
// ONE FILE, no dependencies, CommonJS (.cjs so it also loads inside an ESM package). The same bytes run in AgentFeed (lib/), seeker-rpc (src/),
// the Deep Work and StakeStreak backends: each repo carries a copy and its test pins the sha256, so a fix lands in all of them or in none.
// Design and behaviour are those of nuntius server/src/rpc-endpoints.ts (main d321ea7), without the @solana/kit transport:
//
//   * the primary (a Helius URL in production) is tried first; on HTTP 429, 402, 401, 403 or 5xx, a dropped connection or a timeout the SAME call goes to the
//     next endpoint (RPC_FALLBACKS, by default the free public mainnet RPC). The primary is then left alone for 10 minutes and probed again.
//   * a JSON-RPC error inside an HTTP 200 (a bad parameter, "Too many accounts requested") is an answer, not a failure: it is never retried elsewhere.
//   * methods only Helius serves (DAS, the V2 pagers, getPriorityFeeEstimate) are never sent to a fallback: with the primary out they fail honestly.
//   * every call is counted per method and per endpoint host; startUsageLog() prints one `rpc_usage` line every 10 minutes. A key never reaches a
//     log line or an error message: endpoints are named by host only.
//   * a primary on devnet or testnet gets no fallbacks (the public mainnet RPC would answer for a different cluster).
'use strict';

/** Free, no account, 100 requests per 10 s per IP and 40 per method per 10 s (Solana Foundation public RPC). */
const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';
const FALLBACK_STAY_MS = 10 * 60_000;
const USAGE_EVERY_MS = 10 * 60_000;

/** Methods only Helius answers. Their callers need a plain-RPC path of their own or an honest error. */
const HELIUS_ONLY = new Set([
  'getProgramAccountsV2', 'getTokenAccountsByOwnerV2', 'getPriorityFeeEstimate', 'getTransactionsForAddress',
  'getAsset', 'getAssets', 'getAssetBatch', 'getAssetProof', 'getAssetProofBatch', 'getAssetsByOwner', 'getAssetsByGroup',
  'getAssetsByCreator', 'getAssetsByAuthority', 'getSignaturesForAsset', 'getNftEditions', 'getTokenAccounts', 'searchAssets',
]);

/** An answer that moves the call to the next endpoint: rate limited, out of credits, key refused (401, 403), or down. (401 is one more than nuntius: a revoked key is as unusable as an empty one.) */
function failsOver(status) {
  return status === 429 || status === 402 || status === 401 || status === 403 || status >= 500;
}

const isLoopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';

/** RPC_FALLBACKS: a comma list of https URLs (http only to loopback, for tests). Unset means the public mainnet RPC; empty means none. */
function parseFallbacks(raw) {
  if (raw === undefined || raw === null) return [PUBLIC_MAINNET_RPC];
  const urls = String(raw).split(',').map((u) => u.trim()).filter(Boolean);
  for (const u of urls) {
    let ok = false;
    try { const p = new URL(u); ok = p.protocol === 'https:' || (p.protocol === 'http:' && isLoopback(p.hostname)); } catch { ok = false; }
    if (!ok) throw new Error('RPC_FALLBACKS: every entry must be an https URL');
  }
  return urls;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return 'unknown'; } };
const isHelius = (url) => /(^|\.)helius-rpc\.com$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());
const onTestCluster = (url) => /devnet|testnet/i.test(hostOf(url));

function methodsOfBody(body) {
  if (typeof body !== 'string') return ['unknown'];
  try {
    const p = JSON.parse(body);
    const one = (x) => (x && typeof x === 'object' && typeof x.method === 'string' ? x.method : 'unknown');
    return Array.isArray(p) ? p.map(one) : [one(p)];
  } catch { return ['unknown']; }
}

/** A connection that dropped, never opened or timed out: no answer at all. */
function noAnswer(e) {
  if (!e) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const m = `${e.message || ''} ${String((e && e.cause) || '')}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|UND_ERR|network|terminated/i.test(m);
}

/**
 * Thrown when no endpoint gave an answer (transport: true), or for a JSON-RPC error object (rpc: {code, message}). A transport error's `message` names the
 * hosts that were tried (for logs); `publicMessage` is the same without any host, for a response body.
 */
class RpcError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'RpcError'; Object.assign(this, extra); }
}

class RpcFailover {
  constructor({ primary, fallbacks, name = 'rpc', now = Date.now, stayMs = FALLBACK_STAY_MS, fetch: doFetch, log, timeoutMs = 10_000, heliusOnly = HELIUS_ONLY } = {}) {
    const fb = (fallbacks === undefined ? parseFallbacks(undefined) : fallbacks).filter(Boolean);
    const prim = primary || '';
    // a devnet/testnet primary must not fail over to mainnet; with no primary at all the first fallback is the endpoint
    const rest = prim && onTestCluster(prim) ? [] : fb.filter((u) => u !== prim);
    this.urls = prim ? [prim, ...rest] : rest;
    if (!this.urls.length) throw new Error(`${name}: no RPC endpoint configured`);
    this.name = name; this.now = now; this.stayMs = stayMs; this.doFetch = doFetch || ((...a) => globalThis.fetch(...a));
    this.log = log; this.timeoutMs = timeoutMs; this.heliusOnly = heliusOnly;
    this.primaryDownUntil = 0; this.primaryDown = false;
    this.calls = new Map(); this.hosts = new Map(); this.failedByHost = new Map(); this.failovers = 0;
    // bound methods so `new Connection(url, { fetch: ep.fetch })` and `ep.call` can be handed around
    this.fetch = this.fetch.bind(this); this.call = this.call.bind(this); this.post = this.post.bind(this);
  }

  get primary() { return this.urls[0]; }
  primaryUp() { return this.now() >= this.primaryDownUntil; }
  /** The order to try right now: the primary first, unless it failed within the last stayMs. */
  order() { const [p, ...rest] = this.urls; return this.primaryUp() || !rest.length ? this.urls : [...rest, p]; }

  _count(methods, url) {
    for (const m of methods) this.calls.set(m, (this.calls.get(m) || 0) + 1);
    const h = hostOf(url); this.hosts.set(h, (this.hosts.get(h) || 0) + methods.length);
  }
  _failed(url, why) {
    const h = hostOf(url); this.failedByHost.set(h, (this.failedByHost.get(h) || 0) + 1);
    if (url !== this.primary) return;
    this.primaryDownUntil = this.now() + this.stayMs;
    if (!this.primaryDown) {
      this.primaryDown = true; this.failovers++;
      this._log('rpc_failover', { name: this.name, from: hostOf(url), to: hostOf(this.urls[1] || url), why: String(why), forS: Math.round(this.stayMs / 1000) });
    }
  }
  _answered(url) {
    if (url === this.primary && this.primaryDown) { this.primaryDown = false; this._log('rpc_primary_back', { name: this.name, host: hostOf(url) }); }
  }
  _log(event, o) { try { if (this.log) this.log(`${new Date().toISOString()} ${event} ${JSON.stringify(o)}`); } catch { /* never let a log line break a call */ } }

  /** The endpoints to try for these methods, in order. Helius-only methods only ever go to a Helius endpoint, down or not. */
  _plan(methods) {
    if (methods.some((m) => this.heliusOnly.has(m))) return this.urls.filter(isHelius);
    return this.order();
  }

  /**
   * A fetch for JSON-RPC POSTs (web3.js `new Connection(url, { fetch })`). The URL it is called with is ignored: the endpoints decide.
   * Returns the Response of the first endpoint that did not fail over (or the last endpoint's, whatever it was).
   */
  async fetch(_input, init = {}) {
    const methods = methodsOfBody(init.body);
    const plan = this._plan(methods);
    if (!plan.length) throw new RpcError(`${methods.join(',')}: no endpoint answers this method`, { transport: true, status: 503, noEndpoint: true });
    let lastError;
    for (const [i, url] of plan.entries()) {
      const last = i === plan.length - 1;
      this._count(methods, url);
      try {
        const res = await this.doFetch(url, { ...init, signal: init.signal || AbortSignal.timeout(this.timeoutMs) });
        if (!last && failsOver(res.status)) { this._failed(url, res.status); try { await res.body?.cancel(); } catch { /* already closed */ } continue; }
        if (failsOver(res.status)) this._failed(url, res.status); else this._answered(url);
        return res;
      } catch (e) {
        lastError = e;
        if (!noAnswer(e)) throw e;
        this._failed(url, e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'dropped');
        if (last) throw e;
      }
    }
    throw lastError;
  }

  /**
   * One JSON-RPC call. Resolves with `result`. A JSON-RPC error object throws RpcError { rpc }. When no endpoint answered, RpcError { transport: true,
   * status } whose message names the HTTP status of each endpoint (never a URL).
   */
  async call(method, params, { timeoutMs } = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const j = await this.post(body, { timeoutMs, method });
    if (j && j.error) throw new RpcError(String(j.error.message || 'rpc error'), { rpc: j.error, code: j.error.code });
    return j ? j.result : undefined;
  }

  /** A JSON-RPC body (string or object) to the endpoints; resolves with the parsed JSON-RPC response (errors inside it are the caller's). */
  async post(body, { timeoutMs, method } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const methods = method ? [method] : methodsOfBody(text);
    const plan = this._plan(methods);
    if (!plan.length) throw new RpcError(`${methods.join(',')}: no endpoint answers this method`, { transport: true, status: 503, noEndpoint: true });
    const seen = [];
    for (const [i, url] of plan.entries()) {
      const last = i === plan.length - 1;
      this._count(methods, url);
      let res;
      try {
        res = await this.doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: AbortSignal.timeout(timeoutMs || this.timeoutMs) });
      } catch (e) {
        if (!noAnswer(e)) throw e;
        const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'dropped';
        this._failed(url, why); seen.push(`${hostOf(url)} ${why}`);
        if (last) throw new RpcError(`solana rpc unavailable (${seen.join('; ')})`, { transport: true, status: 503, tried: seen, publicMessage: `solana rpc unavailable (${why})` });
        continue;
      }
      if (failsOver(res.status)) {
        this._failed(url, res.status); seen.push(`${hostOf(url)} http ${res.status}`);
        try { await res.body?.cancel(); } catch { /* already closed */ }
        if (last) throw new RpcError(`solana rpc http ${res.status} (${seen.join('; ')})`, { transport: true, status: 503, httpStatus: res.status, tried: seen, publicMessage: `solana rpc http ${res.status}` });
        continue;
      }
      this._answered(url);
      let j;
      try { j = await res.json(); } catch { throw new RpcError(`solana rpc http ${res.status}: not JSON`, { transport: true, status: 503, httpStatus: res.status }); }
      if (!res.ok && !(j && j.error)) throw new RpcError(`solana rpc http ${res.status}`, { transport: true, status: 503, httpStatus: res.status });
      return j;
    }
    throw new RpcError('solana rpc unavailable', { transport: true, status: 503 });
  }

  /** The calls since the last read, per method and per endpoint host, and resets them. */
  takeUsage() {
    const calls = Object.fromEntries([...this.calls].sort((a, b) => b[1] - a[1]));
    const hosts = Object.fromEntries(this.hosts); const failed = Object.fromEntries(this.failedByHost);
    const total = [...this.calls.values()].reduce((s, n) => s + n, 0); const failovers = this.failovers;
    this.calls = new Map(); this.hosts = new Map(); this.failedByHost = new Map(); this.failovers = 0;
    return { calls, hosts, failed, total, failovers };
  }

  /** One `rpc_usage` line now (calls per method, per host, failed attempts per host, whether on the fallback). Skipped when nothing was called. */
  logUsage(log = this.log, windowS) {
    const u = this.takeUsage();
    if (!u.total && !u.failovers) return u;
    const line = { name: this.name, ...(windowS ? { windowS } : {}), total: u.total, ...u.calls,
      ...Object.fromEntries(Object.entries(u.hosts).map(([h, n]) => [`host:${h}`, n])),
      ...Object.fromEntries(Object.entries(u.failed).map(([h, n]) => [`failed:${h}`, n])), failovers: u.failovers, onFallback: !this.primaryUp() };
    try { if (log) log(`${new Date().toISOString()} rpc_usage ${JSON.stringify(line)}`); } catch { /* ignore */ }
    return u;
  }

  /** One `rpc_usage` line every `everyMs` (10 minutes). Returns the stop function. The timer is unref'd. */
  startUsageLog(log = this.log, everyMs = USAGE_EVERY_MS) {
    const h = setInterval(() => this.logUsage(log, Math.round(everyMs / 1000)), everyMs);
    if (h.unref) h.unref();
    return () => clearInterval(h);
  }
}

/** Build one from the usual environment: a primary URL and RPC_FALLBACKS. */
function create(opts) { return new RpcFailover(opts); }

module.exports = { RpcFailover, RpcError, create, parseFallbacks, failsOver, isHelius, hostOf, methodsOfBody, noAnswer, PUBLIC_MAINNET_RPC, FALLBACK_STAY_MS, USAGE_EVERY_MS, HELIUS_ONLY };
