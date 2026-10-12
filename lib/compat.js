// lib/compat.js — answers for what the 404 log showed clients asking for (R2, 2026-10-11).
//
//   stripNetworkSuffix  /api/<route>|eip155:<id> or |solana:<id> (raw or %7C) is served as
//                       /api/<route>; a crawler asked for ~55 of these in two minutes. url
//                       AND originalUrl are rewritten, so the challenge's resource URL is the
//                       clean one; the original stays on req.x402OriginalPath for the rows.
//   mcpGet405           GET /mcp: MCP Streamable HTTP says a server with no GET stream
//                       answers 405 (Allow: POST). POST /mcp is unchanged.
//   makeDiscovery       the CDP Bazaar discovery response shape ({x402Version, items,
//                       pagination}) at the paths crawlers probe, built from the payment
//                       layer's own route configs and requirements: the same source as
//                       /.well-known/x402.json and every 402.
//   makeAgentCard       an A2A agent card: skills = the paid tools, x402 pointer.
//   sharpMoveGone       /api/sharp-move was removed Aug 19: 410 with the closest live routes.

const NET_SUFFIX = /^(\/api\/[^?]*?)(?:\||%7[cC])(?:eip155:\d+|solana:[A-Za-z0-9]{1,64})$/;

function stripNetworkSuffix(req, _res, next) {
  const q = req.url.indexOf('?');
  const path = q < 0 ? req.url : req.url.slice(0, q);
  const m = NET_SUFFIX.exec(path);
  if (m) {
    req.x402OriginalPath = path;
    req.url = m[1] + (q < 0 ? '' : req.url.slice(q));
    req.originalUrl = String(req.originalUrl).replace(path, m[1]);
  }
  next();
}

function mcpGet405(_req, res) {
  res.set('Allow', 'POST').status(405).json({ error: 'GET /mcp is not supported: this MCP server offers no SSE stream. Use POST /mcp (Streamable HTTP).' });
}

const DISCOVERY_PATHS = ['/discovery/resources', '/x402/discovery/resources', '/v1/x402/discovery/resources', '/v2/x402/discovery/resources', '/.well-known/x402/discovery/resources'];

/** deps: getLayer() -> payments.js layer {routes, resourceServer} or null; concreteUrl(pattern) */
function makeDiscovery({ getLayer, concreteUrl }) {
  let cache = null;
  const lastUpdated = new Date().toISOString();
  async function build() {
    const layer = getLayer();
    if (!layer) throw new Error('payment layer not built');
    const items = [];
    for (const [pattern, rc] of Object.entries(layer.routes)) {
      const accepts = [];
      for (const a of rc.accepts) {
        const [r] = await layer.resourceServer.buildPaymentRequirements(a);
        if (r) accepts.push(r);
      }
      items.push({
        resource: concreteUrl(pattern), type: 'http', x402Version: 2, accepts,
        description: rc.description, serviceName: rc.serviceName, tags: rc.tags, iconUrl: rc.iconUrl,
        mimeType: rc.mimeType, extensions: rc.extensions, lastUpdated,
      });
    }
    return items;
  }
  return async function discovery(req, res) {
    try {
      if (!cache) cache = await build();
    } catch {
      return res.set('Retry-After', '30').status(503).json({ error: 'catalog not ready yet', retry_after: 30 });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    res.json({ x402Version: 2, items: cache.slice(offset, offset + limit), pagination: { limit, offset, total: cache.length } });
  };
}

/** deps: PRICES, TAGS, TITLES, questionFor, version, ORIGIN, rails (names), mpp ({active, routes}) */
function makeAgentCard({ PRICES, TAGS, TITLES, questionFor, version, ORIGIN, railNames, mpp, tempo }) {
  return function agentCard(_req, res) {
    res.json({
      protocolVersion: '0.3.0',
      name: 'AgentFeed',
      description: `Live crypto market data for AI agents: a complete Bybit/OKX/Binance liquidation tape, funding radar, Deribit options IV and dealer gamma, stock and index perps, macro calendar, tokenized-equity peg data and Solana on-chain reads. Each skill is a paid HTTP GET (x402, USDC on ${railNames()}); this is not an A2A message endpoint. Full catalog with prices: ${ORIGIN}/.well-known/x402.json`,
      url: ORIGIN,
      preferredTransport: 'HTTP+JSON',
      version,
      provider: { organization: 'ochinimus', url: 'https://ochinimus.app' },
      documentationUrl: `${ORIGIN}/llms.txt`,
      iconUrl: `${ORIGIN}/icon.png`,
      capabilities: {
        streaming: false, pushNotifications: false,
        extensions: [{
          uri: 'https://x402.org',
          description: 'Every skill is paid per call over x402: GET the route, read the 402 challenge (PAYMENT-REQUIRED header, v2; the JSON body is the v1 challenge), pay and repeat.',
          required: true,
          params: { discovery: `${ORIGIN}/.well-known/x402.json`, openapi: `${ORIGIN}/openapi.json`, mcp: `${ORIGIN}/mcp`, mpp: mpp && mpp.active ? mpp.routes : [], mpp_tempo: !!(tempo && tempo.active) },
        }],
      },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: Object.entries(PRICES).map(([pattern, p]) => ({
        id: p.tool,
        name: TITLES[p.tool] || p.tool,
        description: `${p.desc} Price: $${p.usd} per call. GET ${ORIGIN}${pattern.replace(/^GET /, '')}`,
        tags: TAGS[p.tool] || [],
        examples: [questionFor(p.tool)].filter(Boolean),
      })),
    });
  };
}

const SHARP_MOVE_CLOSEST = ['GET /api/oi-spike-scan', 'GET /api/funding-radar', 'GET /api/cascade-scan', 'GET /api/top-movers'];
function makeSharpMoveGone({ PRICES, ORIGIN }) {
  return function sharpMoveGone(_req, res) {
    res.status(410).json({
      error: 'gone',
      route: '/api/sharp-move',
      removed: '2026-08-19',
      was: 'get_sharp_move: a World Cup betting sharp-money detector. AgentFeed no longer sells sports odds.',
      closest_live: SHARP_MOVE_CLOSEST.filter((k) => PRICES[k]).map((k) => ({
        route: `${ORIGIN}${k.replace(/^GET /, '')}`, tool: PRICES[k].tool, price_usd: PRICES[k].usd,
        what: String(PRICES[k].desc).split(/(?<=\.)\s/)[0].slice(0, 200),
      })),
    });
  };
}

// Paid routes are GET-only. Any other verb on a priced path used to fall through to
// Express's HTML "Cannot POST" 404, which a directory probing the verb a catalogue declared
// (10x402: POST for /api/equity-24h) recorded as "no challenge". Now: 405, Allow: GET, JSON.
function makeGetOnly({ PRICES }) {
  const res_ = Object.keys(PRICES).map((k) => new RegExp(`^${k.replace(/^GET /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`));
  return function getOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!res_.some((re) => re.test(req.path))) return next();
    res.set('Allow', 'GET').status(405).json({ error: `${req.method} is not supported on ${req.path}: paid routes are GET. GET it unpaid for the 402 challenge.`, allow: 'GET' });
  };
}

// /pricing and /terms: x402-list counts both as site signals; both were 404.
function makePricing({ PRICES, FREE_TOOLS, ORIGIN, railNames, mpp, tempo }) {
  return function pricing(req, res) {
    const routes = Object.entries(PRICES).map(([k, p]) => ({ route: `${ORIGIN}${k.replace(/^GET /, '')}`, tool: p.tool, price_usd: p.usd })).sort((x, y) => x.price_usd - y.price_usd || x.tool.localeCompare(y.tool));
    const body = {
      service: 'AgentFeed', currency: 'USDC', billing: 'per call, x402 (no subscription, no API key)', rails: railNames(),
      mpp_routes: mpp && mpp.active ? mpp.routes : [],
      mpp_tempo: tempo && tempo.active ? 'tempo/charge on every paid route: Tempo mainnet (chain 4217), OUSD or USDC.e, pull mode' : null,
      note: 'The live 402 challenge of each route is authoritative. A response with status 400 or more is never settled, so a failed call is not charged.',
      paid: routes, free: (FREE_TOOLS || []).map((t) => t),
      machine_readable: { manifest: `${ORIGIN}/.well-known/x402.json`, openapi: `${ORIGIN}/openapi.json` },
    };
    if (!/text\/html/.test(String(req.headers.accept || ''))) return res.json(body);
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>AgentFeed pricing</title><h1>AgentFeed pricing</h1><p>${esc(body.billing)}. USDC on ${esc(body.rails)}. ${esc(body.note)}</p><table border="1" cellpadding="4"><tr><th>tool</th><th>price (USD)</th><th>route</th></tr>${routes.map((r) => `<tr><td>${esc(r.tool)}</td><td>${r.price_usd}</td><td>${esc(r.route)}</td></tr>`).join('')}</table><p>Free: ${esc(body.free.join(', '))}. Machine-readable: <a href="${esc(body.machine_readable.manifest)}">x402 manifest</a>, <a href="${esc(body.machine_readable.openapi)}">OpenAPI</a>.</p>`);
  };
}

const TERMS = `AgentFeed terms of use (x402.ochinimus.app). Last updated 2026-10-12.

1. Service. AgentFeed is a read-only crypto market-data API. Paid routes are paid per call in USDC over x402, or over MPP (tempo/charge on every paid route, solana/charge on /api/sol-price and /api/btc-price). There are no accounts and no API keys.
2. Payment. Each paid call is settled once, for the price in its 402 challenge. A response with status 400 or more is never settled, so a failed call is not charged. A settled payment is final.
3. Data. Data is provided as is, for information only. It is not financial, investment or trading advice. There is no warranty of accuracy, completeness or availability; each response states its sources and age.
4. Use. Do not attack or overload the service. Rate limits apply: 240 GET requests per minute per IP.
5. Records. Per request we log the route, status, IP address and user agent, and for a settled payment the payer address and transaction. These records are used to run and account for the service. No other personal data is collected.
6. Changes. Prices and routes can change; the live 402 challenge is authoritative.

Contact: ochinimus@gmail.com
`;
function termsHandler(_req, res) { res.type('text/plain').send(TERMS); }

module.exports = { stripNetworkSuffix, mcpGet405, DISCOVERY_PATHS, makeDiscovery, makeAgentCard, makeSharpMoveGone, makeGetOnly, makePricing, termsHandler, NET_SUFFIX };
