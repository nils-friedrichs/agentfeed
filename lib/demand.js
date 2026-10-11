// lib/demand.js — what people ask for that we do not sell, and who reads a price and leaves.
//
// Both hooks only observe: they run on 'finish', after the response is sent, and never
// change it.
//   404s       one calls row (status not_found, tool unknown_route, path, UA, ip) per
//              unknown GET path, at most one per ip and path per hour, scanner probes
//              (.env, .php, wp-, .git) skipped. "Unknown" = no route matched (req.route
//              unset), so a route that answers its own 404 (/api/sample/<bad>) is not one.
//   unpaid 402 a counter row (day, route, ip, user_agent) += 1 for every 402 where the
//              request presented no payment at all: someone read the price and left.
// Neither touches status 'paid', so revenue (paid_revenue, afwatch, the digest) is unchanged.

const SCANNER = /\.env|\.php|wp-|\.git/i;
const HOUR = 3600e3;

function makeDemand({ db, logCall, PRICES }) {
  const routes = Object.entries(PRICES).map(([pattern, p]) => [new RegExp(`^${pattern.replace(/^GET /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`), p.tool]);
  const toolFor = (path) => (routes.find(([re]) => re.test(path)) || [null, 'unpriced_route'])[1];
  db.exec(`CREATE TABLE IF NOT EXISTS unpaid_402 (
    day TEXT NOT NULL, route TEXT NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, route, ip, user_agent)) WITHOUT ROWID;`);
  const bump = db.prepare(`INSERT INTO unpaid_402 (day, route, ip, user_agent, n) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT (day, route, ip, user_agent) DO UPDATE SET n = n + 1`);
  const seen = new Map(); // ip|path -> last logged ms

  const presented = (req) => req.headers['payment-signature'] != null || req.headers['x-payment'] != null
    || ['authorization', 'payment-authorization'].some((h) => typeof req.headers[h] === 'string' && /^\s*payment\s+\S/i.test(req.headers[h]))
    || req.x402FromAuthorization || req.x402PlainReason || req.x402v1;

  return function demand(req, res, next) {
    // read before any later middleware rewrites or drops the payment headers
    const paid = presented(req);
    res.on('finish', () => {
      try {
        if (req.method === 'GET' && res.statusCode === 404 && !req.route) {
          const path = String(req.path || '').slice(0, 300);
          if (SCANNER.test(path)) return;
          const k = `${req.callerIp}|${path}`, now = Date.now();
          if (seen.has(k) && now - seen.get(k) < HOUR) return;
          seen.set(k, now);
          if (seen.size > 20000) for (const [kk, t] of seen) if (now - t >= HOUR) seen.delete(kk);
          logCall({ tool: 'unknown_route', status: 'not_found', ip: req.callerIp, req_path: path, user_agent: req.headers['user-agent'], method: req.method });
        } else if (res.statusCode === 402 && !paid) {
          bump.run(new Date().toISOString().slice(0, 10), toolFor(req.path), String(req.callerIp || '?'), String(req.headers['user-agent'] || '-').slice(0, 200));
        }
      } catch { /* observation only: never fail a request over it */ }
    });
    next();
  };
}

module.exports = { makeDemand, SCANNER };
