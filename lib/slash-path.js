// lib/slash-path.js — a path parameter that holds a literal slash (R17, 19 Oct 2026).
//
// A DOI is `10.1038/nature14539`. /api/paper/:doi is one path segment, so the slash had to travel as %2F, and x402-list's path validator
// (letters, digits and / _ . - ~ only) rejects both %2F and a ?doi= query. The slash form /api/paper/10.1038/nature14539 is rewritten here,
// before the rate limiter, the key rail and the paywall, to the canonical one-segment form /api/paper/10.1038%2Fnature14539: the same
// route, price, 402 (only the echoed resource URL differs), sample and handler, and the route count does not change. The %2F form and the
// ?doi= form (server.js) keep working. Only the bases listed here are rewritten.
'use strict';

const SLASH_PARAM_BASES = ['/api/paper'];

function slashPathCanonical(bases = SLASH_PARAM_BASES) {
  return function slashPath(req, _res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const path = req.path;
    for (const base of bases) {
      if (!path.startsWith(`${base}/`)) continue;
      const rest = path.slice(base.length + 1);
      if (!rest.includes('/') || rest.endsWith('/') || rest.startsWith('/')) return next();      // one segment already, or malformed: leave it
      let value;
      try { value = decodeURIComponent(rest); } catch { return next(); }                           // a broken %-escape stays a 404
      const q = req.url.indexOf('?');
      req.url = `${base}/${encodeURIComponent(value)}${q >= 0 ? req.url.slice(q) : ''}`;           // Express re-derives req.path from req.url
      return next();
    }
    return next();
  };
}

module.exports = { slashPathCanonical, SLASH_PARAM_BASES };
