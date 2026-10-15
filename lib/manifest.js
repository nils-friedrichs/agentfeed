// lib/manifest.js — the accepts of /.well-known/x402.json, built by the payment layer itself (R10 F1).
//
// The manifest used to list Solana plus evmRails() by hand, so Algorand (and the half-price batch-settlement and Gateway
// accepts) were in every 402 and missing from the manifest. Here each route's accepts come from the SAME route config the
// x402 middleware answers with (payments.js routeAccepts, layer.routes) through the same core call the middleware makes for a
// 402, resourceServer.buildPaymentRequirementsFromOptions. So scheme, network, amount, asset and payTo are the 402's, and any
// rail added to the 402 later is in the manifest with no second edit. Scheme enrichment at 402 time can only ADD keys to
// `extra` (@x402/core asserts it), never change those five.
//
// Built once, after the facilitators' /supported has been read (buildPaymentRequirements throws before that); a failure is
// not cached, so the next request retries.
'use strict';

// Tokens whose decimals or symbol are not USDC's 6 / "USDC", keyed `${network}|${asset}` (lower-case): the R10 Phase A rows
// (lib/ext-rails.js) add theirs, so AUSD, USDG and USDC.e are named as what they are.
const { EXT_RAILS } = require('./ext-rails');
const TOKENS = {};
for (const r of EXT_RAILS) TOKENS[`${r.network}|${r.token.address.toLowerCase()}`] = { symbol: r.token.symbol, decimals: r.token.decimals };
const EXT_BY_NET = new Map(EXT_RAILS.map((r) => [r.network, r]));

function tokenOf(network, asset) {
  return TOKENS[`${network}|${String(asset).toLowerCase()}`] || { symbol: 'USDC', decimals: 6 };
}

/**
 * The accept as the 402 carries it, plus the token symbol and the USD price for a reader that does not do units. An accept on a
 * network outside the default 402 (lib/ext-rails.js, R10 Phase A) says how to get it: `on_request` is the suffix that makes the
 * route's 402 carry it (GET /api/<route>|<network>); a payment on it is accepted on the plain URL as well.
 */
function manifestAccept(r) {
  const t = tokenOf(r.network, r.asset);
  const usd = Math.round((Number(r.amount) / 10 ** t.decimals) * 10 ** t.decimals) / 10 ** t.decimals;
  const ext = EXT_BY_NET.get(r.network);
  return { scheme: r.scheme, network: r.network, amount: r.amount, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, ...(r.extra && Object.keys(r.extra).length ? { extra: r.extra } : {}), asset_symbol: t.symbol, price_usd: usd, ...(ext && !ext.inDefault ? { on_request: `|${r.network}` } : {}) };
}

/** deps: getLayer() -> payments.js layer {routes, resourceServer} or null (payments off). Returns async () => Map(pattern -> accepts[]). */
function makeManifestAccepts({ getLayer }) {
  let built = null;
  return async function manifestAccepts() {
    if (built) return built;
    const layer = getLayer();
    if (!layer) return new Map();
    const out = new Map();
    for (const [pattern, rc] of Object.entries(layer.routes)) {
      const reqs = await layer.resourceServer.buildPaymentRequirementsFromOptions(rc.accepts, {});
      out.set(pattern, reqs.map(manifestAccept));
    }
    built = out;
    return built;
  };
}

/**
 * Waits until every facilitator in `probes` ([{ name, network }]) has reported, then returns { missing: [probe, ...], waitedMs }.
 * A facilitator has reported when the resource server holds a supported kind for its probe network: that map is filled by the
 * initialize() the x402 middleware runs at boot, which reads the facilitators one after another. This only READS it. It never
 * calls initialize() (a second call clears the maps before refetching, under live traffic) and never calls a facilitator.
 * Polls with backoff (first, then doubling to maxStep) until capMs; `sleep` and `now` are injectable for tests.
 */
async function waitForFacilitators({ getLayer, capMs = 60000, first = 500, maxStep = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const t0 = now();
  let delay = first;
  for (;;) {
    const layer = getLayer();
    const probes = (layer && layer.facilitatorProbes) || [];
    const rs = layer && layer.resourceServer;
    const missing = probes.filter((p) => {
      try { return !(rs && typeof rs.getSupportedKind === 'function' && rs.getSupportedKind(2, p.network, 'exact')); } catch { return true; }
    });
    const waitedMs = now() - t0;
    if (!missing.length || waitedMs >= capMs) return { missing, waitedMs };
    await sleep(Math.min(delay, capMs - waitedMs));
    delay = Math.min(delay * 2, maxStep);
  }
}

/**
 * The startup build (server.js, after listen): wait for the facilitators, then build the manifest once. One log line either way.
 * If a facilitator never reports within the cap the line names it and nothing is built (the first discovery request builds it,
 * and a failure is not cached); if they all reported and the build still fails, that is a different problem and says so.
 */
async function startupManifest({ getLayer, manifestAccepts, log = console.log, capMs = 60000, sleep, now } = {}) {
  const { missing } = await waitForFacilitators({ getLayer, capMs, sleep, now });
  if (missing.length) {
    log(`[manifest] ${missing.length === 1 ? 'facilitator' : 'facilitators'} not reporting after ${Math.round(capMs / 1000)} s: ${missing.map((m) => `${m.name} (${m.network})`).join(', ')}; the manifest builds on the first request that finds ${missing.length === 1 ? 'it' : 'them'} ready`);
    return null;
  }
  try {
    const m = await manifestAccepts();
    log(`[manifest] accepts built for ${m.size} routes`);
    return m;
  } catch (e) {
    log(`[manifest] build failed after every facilitator reported: ${e.message}`);
    return null;
  }
}

module.exports = { makeManifestAccepts, manifestAccept, tokenOf, TOKENS, waitForFacilitators, startupManifest };
