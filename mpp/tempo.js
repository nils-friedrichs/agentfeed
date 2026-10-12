// mpp/tempo.js — MPP `tempo`/`charge` on every paid route (R3), beside x402 and the
// solana/charge gate on /api/sol-price and /api/btc-price (mpp/index.js, untouched).
//
// Chain 4217 (Tempo mainnet, rpc.tempo.xyz), recipient PAY_TO_EVM, two TIP-20 tokens with 6
// decimals: OUSD 0x20c0...6a37da5c996874be first, then USDC.e 0x20c0...b9537d11c60e8b50
// (mppx 0.10.1's own mainnet default). Both read on-chain 2026-10-11 (symbol, decimals);
// a plain EOA receives either with no setup (fresh recipients seen in recent transfers).
// No fee payer, no key on the box: every challenge leaves feePayer absent, the payer pays gas.
//
// SETTLEMENT RULE, same as x402: no settlement when the handler answers >= 400.
//   tempo charge has two paid credential types. `hash` (push) is a transaction the payer
//   already broadcast: it settles BEFORE any handler runs, so it is never accepted, and
//   every challenge says supportedModes ['pull']. `transaction` (pull) is a signed
//   transaction this server broadcasts: mppx validateCredential() checks it (challenge HMAC,
//   expiry, route scope and amount binding, transfer + memo, eth_call simulation) WITHOUT
//   broadcasting; the handler's response is held; broadcastCredential() runs only if the
//   handler answered < 400. A failed broadcast answers 402 and the data is withheld.
//
// The challenge goes in WWW-Authenticate only (appended to any solana challenge already
// there); PAYMENT-REQUIRED is never touched.

const TEMPO_CHAIN_ID = 4217;
const TOKENS = [
  { symbol: 'OUSD', address: '0x20c0000000000000000000006a37da5c996874be' },
  { symbol: 'USDC.e', address: '0x20c000000000000000000000b9537d11c60e8b50' },
];
const DECIMALS = 6;
const PROBLEM_BASE = 'https://paymentauth.org/problems/';

let state = null; // { instances: [{ symbol, address, mppx }], routes: [[re, pattern, amount]], Credential, Receipt }

// mppx tempo.charge takes the amount in TOKEN units ("0.001") and scales it by decimals itself;
// the challenge then carries base units (1000). Measured: passing "1000" quoted 1000 USDC.
const usdToUnits = (usd) => String(Math.round(Number(usd) * 10 ** DECIMALS));
const tokenAmount = (usd) => (Math.round(Number(usd) * 10 ** DECIMALS) / 10 ** DECIMALS).toFixed(DECIMALS).replace(/0+$/, '').replace(/\.$/, '');

async function init({ prices, recipient, secretKey, realm, store }) {
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('tempo: recipient (PAY_TO_EVM) missing or not an EVM address');
  if (!secretKey || secretKey.length < 32) throw new Error('tempo: MPP_SECRET_KEY missing or shorter than 32 characters');
  const { Mppx, tempo } = await import('mppx/server');
  const { Credential, Receipt } = await import('mppx');
  const instances = TOKENS.map((t) => ({
    ...t,
    mppx: Mppx.create({
      realm,
      secretKey,
      methods: [tempo.charge({ recipient, currency: t.address, decimals: DECIMALS, supportedModes: ['pull'], ...(store ? { store, storeKeyPrefix: `tempo:${t.symbol}:` } : {}) })],
    }),
  }));
  const routes = Object.entries(prices).map(([pattern, p]) => [
    new RegExp(`^${pattern.replace(/^GET /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`),
    pattern, tokenAmount(p.usd), usdToUnits(p.usd),
  ]);
  state = { instances, routes, Credential, Receipt, realm };
  console.log(`[mpp] tempo/charge active: chain=${TEMPO_CHAIN_ID} tokens=${TOKENS.map((t) => t.symbol).join(',')} routes=${routes.length} modes=pull feePayer=false`);
  return state;
}

const routeFor = (path) => {
  if (!state) return null;
  const r = state.routes.find(([re]) => re.test(path));
  return r ? { pattern: r[1], amount: r[2], units: r[3] } : null;
};
const webRequest = (req) => new Request(`https://${req.headers.host || 'x402.ochinimus.app'}${req.originalUrl}`, { method: req.method });
const chargeOptions = (route) => ({ amount: route.amount, scope: route.pattern, chainId: TEMPO_CHAIN_ID });

/** One WWW-Authenticate challenge per token, for this route. */
async function challenges(req, route) {
  const out = [];
  for (const i of state.instances) {
    try {
      const r = await i.mppx.charge(chargeOptions(route))(webRequest(req));
      const h = r.status === 402 && r.challenge.headers.get('WWW-Authenticate');
      if (h) out.push(h);
    } catch (e) {
      console.error(`[mpp] tempo challenge (${i.symbol}) failed:`, e && e.message);
    }
  }
  return out;
}

// "Payment <credential>" in Authorization or Payment-Authorization, if its challenge is tempo.
function tempoCredential(req) {
  for (const h of ['authorization', 'payment-authorization']) {
    const raw = req.headers[h];
    if (typeof raw !== 'string') continue;
    if (!/^\s*payment\s+\S+\s*$/i.test(raw)) continue;
    const serialized = raw.trim(); // mppx (de)serializes WITH the 'Payment ' scheme prefix
    try {
      const c = state.Credential.deserialize(serialized);
      if (c && c.challenge && c.challenge.method === 'tempo') return { header: h, serialized, credential: c };
    } catch { /* not ours to judge: solana or garbage */ }
  }
  return null;
}

function refuse(res, status, type, title, detail, fresh) {
  res.statusCode = status;
  if (fresh && fresh.length) res.setHeader('WWW-Authenticate', fresh);
  res.setHeader('Content-Type', 'application/problem+json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ type: PROBLEM_BASE + type, title, status, detail }));
}
const problemOf = (e) => {
  const name = String((e && e.name) || '');
  if (/InvalidChallenge/.test(name)) return ['invalid-challenge', 'Invalid Challenge'];
  if (/InvalidPayload|Malformed/.test(name)) return ['malformed-credential', 'Malformed Credential'];
  return ['verification-failed', 'Verification Failed'];
};

/** Express middleware: add the tempo challenge to 402s, or take a tempo payment. */
async function gate(req, res, next) {
  if (!state || req.method !== 'GET') return next();
  const route = routeFor(req.path);
  if (!route) return next();
  const tc = tempoCredential(req);

  if (!tc) {
    // Unpaid, or paid some other way: if the response ends up a 402, it carries tempo too.
    if (req.headers['payment-signature'] != null || req.headers['x-payment'] != null) return next();
    let fresh = null;
    try { fresh = await challenges(req, route); } catch { fresh = null; }
    if (fresh && fresh.length) {
      const writeHead = res.writeHead;
      res.writeHead = function (statusCode, ...rest) {
        if ((statusCode || this.statusCode) === 402) {
          const had = this.getHeader('WWW-Authenticate');
          this.setHeader('WWW-Authenticate', [...(had == null ? [] : Array.isArray(had) ? had : [String(had)]), ...fresh]);
        }
        return writeHead.call(this, statusCode, ...rest);
      };
    }
    return next();
  }

  // A tempo credential. Pick the instance whose token the challenge named.
  const currency = String((tc.credential.challenge.request && tc.credential.challenge.request.currency) || '').toLowerCase();
  const inst = state.instances.find((i) => i.address === currency);
  const fresh = await challenges(req, route).catch(() => []);
  if (!inst) return refuse(res, 402, 'invalid-challenge', 'Invalid Challenge', 'tempo credential names a token this server does not offer', fresh);
  const ptype = tc.credential.payload && tc.credential.payload.type;
  if (ptype !== 'transaction') {
    return refuse(res, 402, 'verification-failed', 'Verification Failed',
      `tempo ${ptype || 'unknown'} credentials are not accepted: send a signed transaction (pull mode) and this server broadcasts it after the response is ready, so a failed call is never charged`, fresh);
  }
  const options = { scope: route.pattern, request: chargeOptions(route) };
  try {
    await inst.mppx.validateCredential(tc.serialized, options);
  } catch (e) {
    const [type, title] = problemOf(e);
    return refuse(res, 402, type, title, String((e && e.message) || 'tempo credential refused').slice(0, 300), fresh);
  }

  // Valid and not yet broadcast. Hide it from the solana gate and the x402 layer, then hold.
  delete req.headers[tc.header];
  req.tempoPending = { symbol: inst.symbol };
  hold(req, res, inst, tc.serialized, options, fresh);
  return next();
}

// Hold the handler's response; broadcast only below 400; a failed broadcast is a 402.
function hold(req, res, inst, serialized, options, fresh) {
  const end = res.end, write = res.write;
  const chunks = [];
  res.write = function (chunk, enc) { if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc)); return true; };
  res.end = function (chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; }
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
    const body = Buffer.concat(chunks);
    const release = () => { res.write = write; res.end = end; return end.call(res, body, cb); };
    if (res.statusCode >= 400) return release();
    inst.mppx.broadcastCredential(serialized, options).then((receipt) => {
      try { res.setHeader('Payment-Receipt', state.Receipt.serialize(receipt)); } catch { /* receipt header is best effort */ }
      const source = (receipt && (receipt.source || receipt.sender)) || null;
      req.mppSettlement = { payer: source, transaction: (receipt && receipt.reference) || null, method: 'tempo', token: inst.symbol };
      return release();
    }).catch((e) => {
      res.write = write; res.end = end;
      res.removeHeader('Content-Length');
      const [type, title] = problemOf(e);
      refuse(res, 402, type, title, `tempo settlement refused: ${String((e && e.message) || 'broadcast failed').slice(0, 280)}`, fresh);
    });
    return res;
  };
}

module.exports = { init, gate, isReady: () => !!state, isTempoCredential: (req) => !!(state && tempoCredential(req)), TEMPO_CHAIN_ID, TOKENS, _usdToUnits: usdToUnits, _tokenAmount: tokenAmount,
  // tests only: run the gate against stand-in mppx instances
  _setStateForTest: (s) => { state = s; } };
