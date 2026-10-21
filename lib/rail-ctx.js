// lib/rail-ctx.js — which accepts this /api request's 402 carries (R10 Phase A).
//
// @x402/core reads a route's `accepts` on every request (x402HTTPResourceServer keeps the config object by reference and
// normalizePaymentOptions reads routeConfig.accepts each time), so payments.js gives each route an `accepts` getter that asks
// this module. The answer:
//   outside an /api request (boot validation, the manifest, the discovery listing)   every accept, so all are checked and listed
//   an /api request that names no on-request network                                   the default list (today's thirteen + the
//                                                                                       ext rows marked inDefault)
//   /api/<route>|<network>, or a payment whose `accepted.network` is an on-request one  today's thirteen + that network only: the
//                                                                                       header stays as small as the default one
// The network a payer chose is read from PAYMENT-SIGNATURE (v2) or X-PAYMENT; this runs after the alias middlewares, so an
// Authorization: Payment or a v2 payload in X-PAYMENT has already been moved to the header core reads. A payload that does not
// decode names no network: the request gets the default list and core refuses the payment as it always has.
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { isApiPath } = require('./canon-path');
const { decodePaymentHeader } = require('./pay-header');

const als = new AsyncLocalStorage();
const SUFFIX_NET = /(?:\||%7[cC])(eip155:\d+)$/;

function paidNetwork(req) {
  const raw = req.headers['payment-signature'] || req.headers['x-payment'];
  if (typeof raw !== 'string' || raw.length > 20000) return null;
  const p = decodePaymentHeader(raw);   // x402's own decoder (lib/pay-header.js, R19c): the same bytes core reads, a leading BOM included
  const n = (p && p.accepted && p.accepted.network) || (p && p.network);
  return typeof n === 'string' && /^eip155:\d+$/.test(n) ? n : null;
}

/** Express middleware: mount right before the x402 gate. */
function railContext(req, _res, next) {
  if (!isApiPath(req.path)) return next();   // every spelling of /api/ (R19a): the same accepts and the same store as on the exact path
  const m = req.x402OriginalPath ? SUFFIX_NET.exec(req.x402OriginalPath) : null;
  als.run({ asked: m ? m[1] : null, paid: paidNetwork(req), matched: null }, next);
}

/**
 * R19b: keep, per request, the payment requirement x402 core MATCHED the payment against (the one this server built from the route's accepts, with
 * the amount it quoted). beforeVerify runs inside verifyPayment for every payment flow, with that server-side requirement, before the handler;
 * lib/tool.js reads it back to log what was charged, so the audit amount never comes from a field of the buyer's header.
 */
function bindMatched(resourceServer) {
  resourceServer.onBeforeVerify(async ({ requirements }) => {
    const s = als.getStore();
    if (s && requirements) s.matched = requirements;
  });
  return resourceServer;
}

/**
 * The accepts for one route under the current request.
 * base: today's accepts (exact + high-frequency); ext: this route's ext accepts in table order; isDefault(network) -> bool.
 */
function acceptsFor(base, ext, isDefault) {
  const s = als.getStore();
  if (!s) return [...base, ...ext];
  const def = ext.filter((a) => isDefault(a.network));
  for (const net of [s.paid, s.asked]) {
    if (!net || isDefault(net)) continue;
    const one = ext.find((a) => a.network === net);
    if (one) return [...base, one];
  }
  return [...base, ...def];
}

module.exports = { railContext, acceptsFor, paidNetwork, bindMatched, als, SUFFIX_NET };
