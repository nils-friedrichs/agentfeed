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

// Tokens whose decimals or symbol are not USDC's 6 / "USDC", keyed `${network}|${asset}` (lower-case). Every accept on the
// live 402 today is a 6-decimal USDC; a rail with another token adds its entry here.
const TOKENS = {};

function tokenOf(network, asset) {
  return TOKENS[`${network}|${String(asset).toLowerCase()}`] || { symbol: 'USDC', decimals: 6 };
}

/** The accept as the 402 carries it, plus the token symbol and the USD price for a reader that does not do units. */
function manifestAccept(r) {
  const t = tokenOf(r.network, r.asset);
  const usd = Math.round((Number(r.amount) / 10 ** t.decimals) * 1e6) / 1e6;
  return { scheme: r.scheme, network: r.network, amount: r.amount, asset: r.asset, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, ...(r.extra && Object.keys(r.extra).length ? { extra: r.extra } : {}), asset_symbol: t.symbol, price_usd: usd };
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

module.exports = { makeManifestAccepts, manifestAccept, tokenOf, TOKENS };
