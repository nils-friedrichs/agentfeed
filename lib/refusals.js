// lib/refusals.js — one audit row for every payment that was presented and refused.
//
// On Sep 28 2026 the first base-balance payment of Phase 6 came back 402,
// uncharged, and left no trace: no calls row, no reason, nothing in the log. A
// buyer who presents a payment and is still answered 402 was turned away, so
// that is recorded now: ONE calls row, status payment_refused, the reason the
// facilitator or the middleware gave, the route, and the payer when the payment
// names one. Never the signature, the transaction or the payload.
//
// Presented means a payment on the request:
//   x402  PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1): base64 JSON payload
//   MPP   Authorization or Payment-Authorization: Payment <credential>
// A plain unpaid request presents nothing and writes nothing: its 402 is the
// challenge, not a refusal.
//
// Where the reason is, read from @x402/express 2.17.0 and mpp/index.js:
//   x402 verify refusal   PAYMENT-REQUIRED header, base64 JSON, .error
//   x402 settle refusal   PAYMENT-RESPONSE header, base64 JSON, .errorReason
//   MPP refusal           application/problem+json body, .title and .detail
// A settlement that THREW answers a bare 402 {} and is recorded with that said.
'use strict';
const { decodeTransactionFromPayload, getTokenPayerFromTransaction } = require('@x402/svm');
const { decodePaymentHeader } = require('./pay-header');

const b64json = (v) => {
  if (v == null) return null;
  try { return JSON.parse(Buffer.from(String(v), 'base64').toString('utf8')); } catch { return null; }
};

// The payer an x402 payment names, or null. Decoding never throws into a request.
function x402Payer(header) {
  const p = b64json(header);
  const payload = p && p.payload;
  if (!payload || typeof payload !== 'object') return null;
  // exact EVM: the EIP-3009 authorization names its sender
  if (payload.authorization && typeof payload.authorization.from === 'string') return payload.authorization.from;
  // exact SVM: the transfer authority inside the transaction, the way the facilitator reads it
  if (typeof payload.transaction === 'string') {
    try { return getTokenPayerFromTransaction(decodeTransactionFromPayload({ transaction: payload.transaction })) || null; } catch { return null; }
  }
  return null;
}

// What the client says it is paying, from the payment header it sent: the requirement it copied into `accepted` (x402 v2) and the
// resource it was for. Only these named, public fields are read -- x402Version, scheme, network, asset, amount, payTo,
// maxTimeoutSeconds and the resource PATH -- so the signature, the authorization (sender, nonce, validity window) and the
// transaction never reach the row. A field the client did not send reads '-'. A v1 payment carries scheme and network at the top
// level and no requirement object, so those two are all it shows. Added 15 Oct 2026 (R13): a payer refused "No matching payment
// requirements" left only that sentence, which cannot tell a testnet network from a stale price or a different payTo.
const offerField = (v, max = 96) => (v == null || typeof v === 'object' ? '-' : (String(v).replace(/[^\w.:\/{}%$@+,-]/g, '?').slice(0, max) || '-'));
function resourcePath(resource) {
  const u = typeof resource === 'string' ? resource : resource && typeof resource === 'object' ? resource.url : null;
  if (typeof u !== 'string' || !u) return '-';
  let path = u;
  try { path = new URL(u).pathname; } catch { path = u.startsWith('/') ? u : '-'; }
  return offerField(path.split('?')[0].split('#')[0], 120);
}
function offeredRequirement(header) {
  const p = b64json(header);
  if (!p || typeof p !== 'object') return null;
  const a = p.accepted && typeof p.accepted === 'object' ? p.accepted : null;
  const top = a || p;
  return `offered x402Version=${offerField(p.x402Version)} scheme=${offerField(top.scheme)} network=${offerField(top.network)} asset=${offerField(a && a.asset)} amount=${offerField(a && a.amount)} payTo=${offerField(a && a.payTo)} maxTimeoutSeconds=${offerField(a && a.maxTimeoutSeconds)} resource=${resourcePath(p.resource)}`;
}

// The SHAPE of a payment header the middleware could not read, never its
// content: which header, its length, whether it is base64 that decodes to JSON
// (and the x402Version it claims, a number), and the character classes of its
// first eight characters (A upper, a lower, 9 digit, the symbol itself for
// + / = - _ and ? for anything else). Enough to tell a v1 client, a truncated
// header and plain garbage apart in the audit table without storing a payment.
function headerShape(req) {
  const name = req.headers['payment-signature'] != null ? 'PAYMENT-SIGNATURE' : 'X-PAYMENT';
  const v = String(req.headers['payment-signature'] ?? req.headers['x-payment'] ?? '');
  const p = b64json(v);
  const prefix = v.slice(0, 8).replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9').replace(/[^Aa9+/=_-]/g, '?');
  const version = p && Number.isInteger(p.x402Version) ? ` x402Version=${p.x402Version}` : '';
  return `${name} len=${v.length} prefix=${prefix} base64json=${p ? 'yes' : 'no'}${version}`;
}

// The SHAPE of an MPP-style credential (Authorization or Payment-Authorization:
// "Payment <credential>"), never the credential: header, scheme word, length, the
// same eight-character class prefix as headerShape, whether it decodes as base64url
// JSON and as standard base64 JSON (with the x402Version it claims), how many dots
// it has (a JWS has two), and whether it looks like name=value auth-params.
const MPP_HEADERS = ['authorization', 'payment-authorization'];
const classes = (v) => v.slice(0, 8).replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9').replace(/[^Aa9+/=_-]/g, '?');
function decodeJson(v, enc) {
  try {
    const t = Buffer.from(v, enc).toString('utf8');
    const j = JSON.parse(t);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}
function mppCredential(req) {
  for (const h of MPP_HEADERS) {
    const raw = req.headers[h];
    if (typeof raw !== 'string') continue;
    const m = /^\s*(payment)\s+([\s\S]+?)\s*$/i.exec(raw);
    if (m) return { header: h, scheme: m[1], value: m[2] };
  }
  return null;
}
function mppShape(req) {
  const c = mppCredential(req);
  if (!c) return null;
  const v = c.value;
  const url = decodeJson(v, 'base64url');
  const std = /^[A-Za-z0-9+/]+={0,2}$/.test(v) ? decodeJson(v, 'base64') : null;
  const version = std && Number.isInteger(std.x402Version) ? ` x402Version=${std.x402Version}` : url && Number.isInteger(url.x402Version) ? ` x402Version=${url.x402Version}` : '';
  const name = c.header === 'authorization' ? 'Authorization' : 'Payment-Authorization';
  const params = /^[A-Za-z0-9_-]+=("[^"]*"|[^,\s]+)(\s*,\s*[A-Za-z0-9_-]+=("[^"]*"|[^,\s]+))*$/.test(v) ? 'yes' : 'no';
  // an MPP credential names its challenge's method/intent and its payload type (tempo push vs pull)
  const mpp = url && url.challenge && typeof url.challenge.method === 'string' ? ` method=${String(url.challenge.method).slice(0, 16)}/${String(url.challenge.intent || '').slice(0, 16)} payload=${String((url.payload && url.payload.type) || '-').slice(0, 16)}` : '';
  return `${name} scheme=${c.scheme} len=${v.length} prefix=${classes(v)} base64urljson=${url ? 'yes' : 'no'} base64json=${std ? 'yes' : 'no'}${version} dots=${(v.match(/\./g) || []).length} params=${params}${mpp}`;
}

// An x402 payment sent in the MPP header: "Payment <base64 or base64url JSON>" whose
// JSON has x402Version 1 or 2 and a payload. Taken as X-PAYMENT (re-encoded as
// standard base64 of the same bytes), and the MPP header is dropped for this request
// so the MPP gate does not refuse it first. Anything else is left for MPP untouched.
function aliasAuthorizationPayment(req, _res, next) {
  if (req.headers['payment-signature'] != null || req.headers['x-payment'] != null) return next();
  const c = mppCredential(req);
  if (!c || /\s/.test(c.value)) return next();
  for (const enc of ['base64', 'base64url']) {
    let bytes;
    try { bytes = Buffer.from(c.value, enc); } catch { continue; }
    let j = null;
    try { j = JSON.parse(bytes.toString('utf8')); } catch { j = null; }
    if (j && (j.x402Version === 1 || j.x402Version === 2) && j.payload && typeof j.payload === 'object') {
      req.headers['x-payment'] = bytes.toString('base64');
      req.x402FromAuthorization = c.header === 'authorization' ? 'Authorization' : 'Payment-Authorization';
      delete req.headers[c.header];
      return next();
    }
  }
  return next();
}

// MPP credential on a route with no MPP gate: say so in the challenge itself, so a
// client that speaks both can switch to x402. mppPaths() answers the gated paths
// (empty when MPP is off) at request time.
const MPP_ON_X402_ONLY = 'MPP solana credential on a route without solana/charge; solana/charge is offered on /api/sol-price and /api/btc-price, tempo/charge on every paid route';
const MPP_OFF = 'MPP credential presented but MPP is not enabled on this server; pay with x402 (PAYMENT-REQUIRED header)';
// tempo credentials are mpp/tempo.js's to judge (every paid route takes them): isTempo(req)
// says when the presented credential's challenge names the tempo method.
function makeMppOnX402Only({ mppPaths, isTempo = () => false }) {
  return function mppOnX402Only(req, _res, next) {
    if (req.headers['payment-signature'] != null || req.headers['x-payment'] != null) return next();
    if (!mppCredential(req)) return next();
    if (isTempo(req)) return next();
    const paths = mppPaths() || [];
    if (paths.includes(req.path)) return next();
    req.x402PlainReason = paths.length ? MPP_ON_X402_ONLY : MPP_OFF;
    next();
  };
}

// A reason is kept as text; any signature, hash or payload it quotes is not.
function scrub(s) {
  return String(s)
    .replace(/0x[0-9a-fA-F]{64,}/g, '<hash>')                  // EVM tx hash or signature (addresses are 40 hex)
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,}/g, '<signature>')      // base58 at signature length (addresses are 32-44)
    .replace(/[A-Za-z0-9+/_-]{100,}={0,2}/g, '<payload>');       // base64 blobs
}

function refusalReason(res, body) {
  const type = String(res.getHeader('content-type') || '');
  if (/application\/problem\+json/i.test(type)) {
    try {
      const p = JSON.parse(body);
      const kind = String(p.type || '').split('/').pop();
      return [kind, p.title, p.detail].filter(Boolean).join(': ') || 'mpp refused the credential';
    } catch { /* fall through to the headers */ }
  }
  const settle = b64json(res.getHeader('payment-response') || res.getHeader('x-payment-response'));
  if (settle && settle.success === false) return `settlement refused: ${settle.errorReason || settle.errorMessage || 'no reason given'}`;
  const req = b64json(res.getHeader('payment-required') || res.getHeader('x-payment-required'));
  // @x402/core reads only a decodable v2 PAYMENT-SIGNATURE (extractPayment returns
  // null on anything else, X-PAYMENT included) and then answers the plain
  // challenge, whose error is exactly this string. Kept, and said what it means.
  if (req && req.error === 'Payment required') return 'verification refused: Payment required (the payment header was not a decodable x402 v2 PAYMENT-SIGNATURE, so the middleware answered its plain challenge)';
  if (req && typeof req.error === 'string' && /^(x402 v1 |MPP (solana )?credential )/.test(req.error)) return req.error;
  if (req && req.error) return `verification refused: ${req.error}`;
  return 'refused with no reason in the response (a settlement that threw answers a bare 402; see the service log)';
}

// A decodable v2 payment with a field missing (no `accepted`, say) makes
// @x402/core throw inside its own matcher -- paymentRequirementsMatchAccepted()
// destructures `accepted` -- and the middleware puts that JavaScript message
// into the 402's .error. Measured 2026-10-08 on the live service: "Cannot
// destructure property 'extra' of 'accepted' as it is undefined." The status was
// already a clean 402; the reason was our stack. A buyer is owed a reason, so a
// JS-error message in the challenge is replaced, and only that: a facilitator's
// own refusal (invalid_exact_svm_payload_..., invalid_exact_evm_payload_...)
// matches none of these patterns and is passed through untouched.
const JS_ERROR = /\b(TypeError|ReferenceError|RangeError|SyntaxError)\b|Cannot (destructure|read propert|set propert)|is not (a function|iterable|defined)|of (undefined|null)\b|undefined is not/;
const MALFORMED = 'invalid_payment_payload: not a well-formed x402 v2 payment; PAYMENT-SIGNATURE needs x402Version 2, an accepted requirement copied from this challenge, and a payload';

// X-PAYMENT, the x402 v1 header name. Measured 2026-10-08: one client (3.14.8.71,
// UA node) presented a payment 126 times across 14 routes over a week and was
// refused every time, because @x402/core's server extractPayment() reads only
// PAYMENT-SIGNATURE (its comment says "handles v1 and v2"; the code does not) --
// and this service's own openapi.json, llms.txt and SKILL.md told buyers to send
// X-PAYMENT until 2026-10-08. The error log, never rotated since Jul 8, holds no
// PAYMENT-SIGNATURE decode warning from that client, so the header it sent was
// X-PAYMENT.
//
// The installed packages cannot serve a true v1 client: neither @x402/evm 2.18
// nor @x402/svm 2.17 ships a v1 SERVER scheme (only v1 client and facilitator),
// the HTTP layer never emits a v1 402 body, and core's v1 match reads
// payload.accepted, which a v1 payload does not have. So: X-PAYMENT carrying a
// valid x402 v2 payload is accepted as PAYMENT-SIGNATURE; a v1 payload is still
// refused, and the 402 now says why instead of a bare "Payment required".
// Reached only when X-PAYMENT is neither a v1 nor a v2 payload: since S4 (lib/x402v1.js)
// an x402Version 1 payload is paid on base and solana, and a v2 one through the alias.
const V1_UNSUPPORTED = 'X-PAYMENT not understood: send base64 JSON with x402Version 1 (exact on base or solana, requirements in this response body) or x402Version 2 (any rail in the PAYMENT-REQUIRED header)';

function aliasXPayment(req, res, next) {
  const xp = req.headers['x-payment'];
  if (xp == null || req.headers['payment-signature'] != null) return next();
  const p = decodePaymentHeader(xp);   // x402's own decoder (lib/pay-header.js, R19c): a BOM-prefixed v2 payload is aliased like core will read it
  if (p && p.x402Version === 2) {
    req.headers['payment-signature'] = xp;
    // A client that sends X-PAYMENT may read the settlement from X-PAYMENT-RESPONSE.
    const setHeader = res.setHeader;
    res.setHeader = function (name, value) {
      if (String(name).toLowerCase() === 'payment-response') setHeader.call(this, 'X-PAYMENT-RESPONSE', value);
      return setHeader.call(this, name, value);
    };
  } else {
    req.xPaymentNotV2 = true;
  }
  next();
}

function sanitizeChallengeErrors(req, res, next) {
  if (req.headers['payment-signature'] == null && req.headers['x-payment'] == null && !mppCredential(req)) return next();
  const setHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (String(name).toLowerCase() === 'payment-required') {
      const c = b64json(value);
      if (c && req.x402PlainReason && c.error === 'Payment required') {
        // lib/x402v1.js refused a v1 payment and fell through to this plain challenge
        c.error = req.x402PlainReason;
        value = Buffer.from(JSON.stringify(c)).toString('base64');
      } else if (c && typeof c.error === 'string' && JS_ERROR.test(c.error)) {
        c.error = MALFORMED;
        value = Buffer.from(JSON.stringify(c)).toString('base64');
      } else if (c && req.xPaymentNotV2 && c.error === 'Payment required') {
        c.error = V1_UNSUPPORTED;
        value = Buffer.from(JSON.stringify(c)).toString('base64');
      }
    }
    return setHeader.call(this, name, value);
  };
  next();
}

/**
 * deps: { logCall, PRICES, mppPayer }  -- mppPayer(req) decodes an MPP credential's
 * payer (mpp/index.js credentialSource), or is absent when MPP is not loaded.
 */
function makeRefusalRecorder({ logCall, PRICES, mppPayer }) {
  // PRICES pattern -> tool, so the row names the tool the way every other row does
  const routes = Object.entries(PRICES).map(([pattern, p]) => {
    const path = pattern.replace(/^GET /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+');
    return [new RegExp(`^${path}$`), p.tool];
  });
  const toolFor = (path) => (routes.find(([re]) => re.test(path)) || [null, 'unpriced_route'])[1];
  const mppPresented = (req) => ['authorization', 'payment-authorization']
    .some((h) => typeof req.headers[h] === 'string' && /^payment\s+\S/i.test(req.headers[h].trim()));

  return function recordRefusals(req, res, next) {
    const x402 = req.headers['payment-signature'] || req.headers['x-payment'];
    const mpp = mppPresented(req);
    if (!x402 && !mpp) return next();
    // before any alias drops the MPP header
    const mppShapeAtEntry = mpp ? mppShape(req) : null;
    const t0 = Date.now();
    // Only the MPP refusal carries its reason in the body; keep the first 4 KB.
    let body = '';
    const keep = (chunk) => {
      if (chunk == null || typeof chunk === 'function' || body.length >= 4096) return;
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    };
    const write = res.write, end = res.end;
    res.write = function (chunk, ...rest) { keep(chunk); return write.call(this, chunk, ...rest); };
    res.end = function (chunk, ...rest) { keep(chunk); return end.call(this, chunk, ...rest); };
    res.on('finish', () => {
      if (res.statusCode !== 402) return;
      let payer = null;
      try { payer = (mpp && mppPayer ? mppPayer(req) : null) || (x402 ? x402Payer(x402) : null) || (req.x402FromAuthorization && req.headers['x-payment'] ? x402Payer(req.headers['x-payment']) : null); } catch { payer = null; }
      logCall({
        tool: toolFor(req.path),
        status: 'payment_refused',
        payer_wallet: payer || req.tempoPayer || null,
        // a refused tempo payment keeps the hash of its signed transaction, so a late landing
        // can be found (ops/af-digest.js --alert); other refusals record no signature
        ...(req.tempoRefusedTx ? { tx_sig: req.tempoRefusedTx } : {}),
        error_msg: (() => {
          const reason = scrub(refusalReason(res, body));
          // undecodable or v1: say what arrived, by shape only
          let out = (x402 || req.x402FromAuthorization) && /not a decodable x402 v2|invalid_payment_payload|x402 v1|X-PAYMENT not understood/.test(reason) ? `${reason}; header ${req.x402ShapeOverride || headerShape(req)}` : reason;
          if (req.x402FromAuthorization) out = `x402 payment sent in ${req.x402FromAuthorization} (read as X-PAYMENT): ${out}`;
          // what the client offered, on every x402 refusal (verification, settlement, threw), by named public fields only
          const offered = x402 || (req.x402FromAuthorization && req.headers['x-payment']) ? offeredRequirement(x402 || req.headers['x-payment']) : null;
          if (offered) out += `; ${scrub(offered)}`;
          if (mppShapeAtEntry) out += `; mpp ${mppShapeAtEntry}`;
          return out;
        })(),
        latency_ms: Date.now() - t0,
        ip: req.callerIp,
        req_path: req.x402OriginalPath || req.path,
        user_agent: req.headers['user-agent'],
        method: req.method,
      });
    });
    next();
  };
}

module.exports = { makeRefusalRecorder, sanitizeChallengeErrors, aliasXPayment, aliasAuthorizationPayment, makeMppOnX402Only, V1_UNSUPPORTED, MPP_ON_X402_ONLY, _x402Payer: x402Payer, _scrub: scrub, _headerShape: headerShape, _mppShape: mppShape, _offered: offeredRequirement };
