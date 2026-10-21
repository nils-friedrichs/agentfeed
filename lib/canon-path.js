// lib/canon-path.js: the ONE canonical form of a request path, and the matchers built on it (R19, 21 Oct 2026).
//
// Before R19 six places decided "is this a priced path" with their own exact, case-sensitive regex (server.js isPricedPath, keys.pricedFor and
// purchaseGuard, x402v1.patternFor, tempo routeFor, compat.makeGetOnly) while Express routes case-insensitively with an optional trailing slash and
// the x402 gate matches by its own rules. They failed safe only because a variant fell through to the x402 gate, except for the HEAD guard, where
// falling through meant running the paid handler with no payment (HEAD /API/<route>, HEAD /api/<route>/).
//
// canonPath reproduces the rules @x402/core 2.28 routes by (http/index.js normalizePath, and its route regexes are /i): drop the query and fragment,
// percent-decode each segment while keeping an encoded / and \ encoded (so a DOI's %2F stays inside its segment), collapse //, strip the trailing /,
// and lower-case. A spelling x402 would route to a priced route is a priced path everywhere, so the rails agree on what is priced.
'use strict';

function canonPath(p) {
  const raw = String(p == null ? '' : p).split(/[?#]/)[0];
  const decoded = raw.split('/').map((seg) => {
    let d;
    try { d = decodeURIComponent(seg); } catch { return seg; }
    return d.replace(/\//g, '%2F').replace(/\\/g, '%5C');
  }).join('/');
  return decoded.replace(/\/+/g, '/').replace(/(.+?)\/+$/, '$1').toLowerCase();
}

/** True for a path under /api/, however it is spelled. */
const isApiPath = (p) => canonPath(p).startsWith('/api/');

/** The regex of a route pattern ('GET /api/x/:id' or '/api/x/:id') over a canonical path: literal parts lower-cased, :param is one segment. */
function patternRegex(pattern) {
  const body = String(pattern).replace(/^[A-Za-z]+\s+/, '').toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[a-z0-9_]+/g, '[^/]+');
  return new RegExp('^' + body + '$');
}

/**
 * Matcher over route patterns. `items` are pattern strings or objects { pattern, ...extra }; find(path) returns the first matching item as
 * { pattern, ...extra, re } or null, whatever the spelling of `path`.
 */
function pricedMatcher(items) {
  const entries = items.map((it) => {
    const o = typeof it === 'string' ? { pattern: it } : it;
    return { ...o, re: patternRegex(o.pattern) };
  });
  return {
    entries,
    find(path) { const c = canonPath(path); return entries.find((e) => e.re.test(c)) || null; },
    test(path) { return this.find(path) !== null; },
  };
}

module.exports = { canonPath, isApiPath, patternRegex, pricedMatcher };
