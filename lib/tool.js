// lib/tool.js — the route wrapper every /api handler is mounted behind.
//
// Extracted from server.js unchanged so it can be tested without booting the
// service: requiring server.js opens the liquidation, peg and overhang
// databases and then listens, none of which a unit test should do. The two
// functions below are byte-identical to the versions that lived inline; only
// their dependencies moved from the enclosing scope into makeTool()'s argument,
// and test/tool.test.js asserts the behaviour of the real thing rather than a
// copy.
//
// deps: { paymentsOn, PRICES, decodeSettlement, logCall }
function makeTool({ paymentsOn, PRICES, decodeSettlement, logCall }) {
  // ---- did THIS request get paid for?
  //
  // `paid` used to be the process-wide `paymentsOn` flag, so every response said
  // paid:true whenever the x402 layer was mounted at all -- including the free
  // tasters. A judge following the README's "try it free" line ran
  // `curl /api/fear-greed` and was told it had paid for it.
  //
  // The honest answer is "is this route priced": a 200 on a priced route can only
  // happen after the x402 middleware or the MPP gate accepted payment, because
  // both sit in front of the handler and neither lets an unpaid request through.
  // An unpriced route was never charged for.
  //
  // KEYED ON PRICES, NOT ON priceUsd. get_fear_greed is registered as
  // tool('get_fear_greed', 0.001, ...) but is deliberately absent from PRICES --
  // free routes are kept out so the x402 middleware never sees a $0 route -- so
  // the price argument is not evidence of anything. PRICES is the paywall's own
  // table and is the only thing that decides.
  //
  // `req.route.path` is the registered pattern, not the requested URL, so
  // /api/token-risk/<mint> yields '/api/token-risk/:mint' and matches the PRICES
  // key exactly. That holds for expansion.js routes too: register() does
  // app.get(t.route.replace('GET ', ''), ...) while PRICES_ADD is keyed on
  // t.route, so the two are the same string by construction. Verified against
  // the live tree: 17 routes here + 34 from expansion.js, 48 of which are in
  // PRICES and 3 of which are not -- exactly the three published at / as
  // free_tools.
  //
  // NOT read from the settlement header: @x402/express writes that AFTER the
  // response, so at res.json() time it does not exist yet. The audit row in
  // res.on('finish') still reads the real settlement and is untouched.
  function isPaidRoute(req) {
    if (!paymentsOn) return false;
    const pattern = req.route && req.route.path;
    if (!pattern) return false;
    return Object.prototype.hasOwnProperty.call(PRICES, 'GET ' + pattern);
  }

  // ---- route wrapper: timing + audit (captures payer + tx sig from settlement header)
  function tool(name, priceUsd, handler) {
    return async (req, res) => {
      const t0 = Date.now();
      res.on('finish', () => {
        if (res.statusCode !== 200) return; // 402s/errors logged elsewhere or not billed
        const s = (paymentsOn ? decodeSettlement(res) : null) || req.mppSettlement || null;
        logCall({
          tool: name,
          status: s ? 'paid' : 'free',
          payer_wallet: s?.payer || null,
          tx_sig: s?.transaction || null,
          amount_usdc: s ? priceUsd : null,
          latency_ms: Date.now() - t0,
          ip: req.callerIp,
          // a /api/<route>|<network> request (lib/compat.js) keeps the path it asked for
          ...(req.x402OriginalPath ? { req_path: req.x402OriginalPath } : {}),
        });
      });
      try {
        const data = await handler(req);
        res.json({ tool: name, data, paid: isPaidRoute(req) });
      } catch (e) {
        // e.kind === 'bad_request' is set at the throw site by the tools' own
        // input validation (missing/malformed caller parameter, thrown before any
        // upstream call); an unmarked throw is a genuine service failure. Never
        // classify by matching message text. /opt/afwatch/afwatch.js and the
        // solwatch MCP x402_revenue tool both read this table, so the
        // error/bad_request split changes what they report — by design.
        logCall({
          tool: name,
          status: e.kind === 'bad_request' ? 'bad_request' : 'error',
          latency_ms: Date.now() - t0,
          ip: req.callerIp,
          error_msg: e.message,
          req_path: req.path,
          user_agent: req.headers['user-agent'],
          method: req.method,
        });
        // A handler that cannot answer from fresh data (a snapshot past its
        // staleness limit, a source with no liquidity) throws with status 503.
        // Any status >= 400 cancels the x402 settlement, so the caller is never
        // charged; Retry-After says when the collector will have run again.
        if (e.status === 503) {
          // e.retryAfter (seconds) lets a source that knows when it will be back say so, e.g. a history
          // still warming up; capped at an hour so a long wait is never read as "gone"
          const ra = Math.min(Math.max(Math.round(Number(e.retryAfter)) || 60, 1), 3600);
          res.set('Retry-After', String(ra));
          return res.status(503).json({ tool: name, error: e.message, retry_after: ra, ...(e.warming ? { warming: e.warming } : {}) });
        }
        // A caller error that has a closed answer set (an unsupported symbol) names it:
        // `supported` rides on the thrown error and is returned as-is. Status 400 cancels
        // the settlement, so the caller is never charged for a symbol we do not serve.
        res.status(400).json({ tool: name, error: e.message, ...(Array.isArray(e.supported) ? { supported: e.supported } : {}) });
      }
    };
  }

  return { tool, isPaidRoute };
}

module.exports = { makeTool };
