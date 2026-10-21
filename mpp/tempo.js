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
// BROADCAST-ERROR RECOVERY (12 Oct 2026). broadcastCredential() sends with
//   eth_sendRawTransactionSync. On 12 Oct rpc.tempo.xyz answered that call HTTP 502 after
//   2.3 s while the transaction landed in the same second (0x3899c3be...36cf), so the buyer
//   paid and the data was withheld. Now a broadcast error that is not one of mppx's own
//   payment errors (transport, 5xx, timeout, unknown) is not a refusal yet: the hash of the
//   signed transaction (keccak256 of its canonical serialization, as mppx computes it) is
//   polled with eth_getTransactionReceipt every 500 ms on rpc.tempo.xyz and
//   rpc.mainnet.tempo.xyz (chainlist's second mainnet URL, chain id 4217 verified; same
//   Cloudflare front), and after 3 s without a receipt the same raw transaction is sent
//   once more with plain eth_sendRawTransaction. It settles ONLY if the receipt succeeded
//   and carries the TIP-20 TransferWithMemo mppx itself requires: this token, from the
//   signer, to the recipient, the route's exact units, and a memo bound to this server and
//   this challenge. Anything else is the old 402, with the hash logged in tx_sig.
//   Replays: mppx claims the hash in its own store before broadcasting and keeps the claim
//   after a failed broadcast, so a replay inside one process fails with its own
//   PaymentError and never reaches the recovery. Every settled hash (either path) is also
//   claimed in the durable store (mpp_consumed, key tempo:settled:<hash>), and the recovery
//   settles only if it wins that claim, so a replay after a restart is refused too.
//   mppx's client signs with validBefore = now + 25 s (or the challenge expiry, if sooner),
//   so a refused transaction cannot land later than that. R5: the poll runs until the signed
//   transaction's own validBefore + 2 s (capped at 30 s; 15 s when it carries no expiry), so
//   a refusal is never followed by a landing. The normal path also refuses when it loses the
//   durable claim: one payment never delivers data twice.
//
// The challenge goes in WWW-Authenticate only (appended to any solana challenge already
// there); PAYMENT-REQUIRED is never touched.

const { canonPath, patternRegex } = require('../lib/canon-path');
const path = require('path');
const { pathToFileURL } = require('url');

const TEMPO_CHAIN_ID = 4217;
const TOKENS = [
  { symbol: 'OUSD', address: '0x20c0000000000000000000006a37da5c996874be' },
  { symbol: 'USDC.e', address: '0x20c000000000000000000000b9537d11c60e8b50' },
];
const DECIMALS = 6;
const PROBLEM_BASE = 'https://paymentauth.org/problems/';
const RECEIPT_RPCS = ['https://rpc.tempo.xyz', 'https://rpc.mainnet.tempo.xyz'];
const RECOVERY = { pollMs: 500, resendAfterMs: 3000, afterExpiryMs: 2000, capMs: 30000, noExpiryMs: 15000 };
const SETTLED_TTL_MS = 30 * 24 * 3600e3;

let state = null; // { instances: [{ symbol, address, mppx }], routes: [[re, pattern, amount]], Credential, Receipt }

// mppx tempo.charge takes the amount in TOKEN units ("0.001") and scales it by decimals itself;
// the challenge then carries base units (1000). Measured: passing "1000" quoted 1000 USDC.
const usdToUnits = (usd) => String(Math.round(Number(usd) * 10 ** DECIMALS));
const tokenAmount = (usd) => (Math.round(Number(usd) * 10 ** DECIMALS) / 10 ** DECIMALS).toFixed(DECIMALS).replace(/0+$/, '').replace(/\.$/, '');

// Resolved from mpp/ (mppx 0.10.1 and its viem), the same modules mppx's Charge.js uses.
async function loadDeps() {
  const { Credential, Receipt, Errors, Store } = await import('mppx');
  const { keccak256, parseEventLogs } = await import('viem');
  const { Abis, Transaction } = await import('viem/tempo');
  // Attribution is not in mppx's exports map; load the same file Charge.js imports.
  const Attribution = await import(pathToFileURL(path.join(path.dirname(require.resolve('mppx')), 'tempo', 'Attribution.js')).href);
  return { Credential, Receipt, Errors, Store, keccak256, parseEventLogs, Abis, Transaction, Attribution };
}

async function init({ prices, recipient, secretKey, realm, store, db }) {
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('tempo: recipient (PAY_TO_EVM) missing or not an EVM address');
  if (!secretKey || secretKey.length < 32) throw new Error('tempo: MPP_SECRET_KEY missing or shorter than 32 characters');
  const { Mppx, tempo } = await import('mppx/server');
  const { Credential, Receipt, Errors, Store, keccak256, parseEventLogs, Abis, Transaction, Attribution } = await loadDeps();
  const settled = Store.from(db ? require('./store').createSqliteStore(db) : Store.memory(), { keyPrefix: 'tempo:settled:' });
  const instances = TOKENS.map((t) => ({
    ...t,
    mppx: Mppx.create({
      realm,
      secretKey,
      methods: [tempo.charge({ recipient, currency: t.address, decimals: DECIMALS, supportedModes: ['pull'], ...(store ? { store, storeKeyPrefix: `tempo:${t.symbol}:` } : {}) })],
    }),
  }));
  const routes = Object.entries(prices).map(([pattern, p]) => [
    patternRegex(pattern),   // over the canonical path (lib/canon-path.js, R19a)
    pattern, tokenAmount(p.usd), usdToUnits(p.usd),
  ]);
  state = { instances, routes, Credential, Receipt, realm, recipient,
    PaymentError: Errors.PaymentError, settled, tryClaim: Store.tryClaim,
    decode: makeDecoder(Transaction, keccak256), matchTransfer: makeMatcher(parseEventLogs, Abis, Attribution),
    rpc: jsonRpc, recovery: RECOVERY };
  console.log(`[mpp] tempo/charge active: chain=${TEMPO_CHAIN_ID} tokens=${TOKENS.map((t) => t.symbol).join(',')} routes=${routes.length} modes=pull feePayer=false`);
  return state;
}

const routeFor = (path) => {
  if (!state) return null;
  const c = canonPath(path);   // a credential is taken on every spelling x402 routes to a priced route (R19a)
  const r = state.routes.find(([re]) => re.test(c));
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
  hold(req, res, inst, tc, options, fresh, route);
  return next();
}

// Hold the handler's response; broadcast only below 400; a failed broadcast is a 402,
// unless the transaction is proven landed (see BROADCAST-ERROR RECOVERY above).
function hold(req, res, inst, tc, options, fresh, route) {
  const end = res.end, write = res.write;
  const chunks = [];
  const signedP = state.decode && tc.credential.payload && tc.credential.payload.signature
    ? state.decode(tc.credential.payload.signature).catch(() => null) : Promise.resolve(null);
  res.write = function (chunk, enc) { if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc)); return true; };
  res.end = function (chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; }
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
    const body = Buffer.concat(chunks);
    const release = () => { res.write = write; res.end = end; return end.call(res, body, cb); };
    if (res.statusCode >= 400) return release();
    const settle = (receipt, payer) => {
      try { res.setHeader('Payment-Receipt', state.Receipt.serialize(receipt)); } catch { /* receipt header is best effort */ }
      req.mppSettlement = { payer: payer || null, transaction: (receipt && receipt.reference) || null, method: 'tempo', token: inst.symbol };
      return release();
    };
    const refuseNow = (e, signed, extra) => {
      res.write = write; res.end = end;
      res.removeHeader('Content-Length');
      if (signed) { req.tempoRefusedTx = signed.hash; req.tempoPayer = signed.from; }
      const [type, title] = problemOf(e);
      refuse(res, 402, type, title, `tempo settlement refused: ${String((e && e.message) || 'broadcast failed').slice(0, 280)}${extra ? `; ${extra}` : ''}`, fresh);
    };
    // .then(ok, err): an error thrown while settling must not be read as a broadcast failure
    inst.mppx.broadcastCredential(tc.serialized, options).then(async (receipt) => {
      const signed = await signedP;
      const source = (receipt && (receipt.source || receipt.sender)) || (signed && signed.from) || null;
      if (signed && state.settled) {
        let won = true;
        try { won = await state.tryClaim(state.settled, signed.hash.toLowerCase(), Date.now() + SETTLED_TTL_MS); } catch (e) {
          // a store failure must not cost a buyer whose transaction landed their data
          console.error(`[mpp] tempo durable claim failed for ${signed.hash}: ${String(e && e.message).slice(0, 120)}`);
        }
        if (won === false) return refuseNow(new Error('this transaction was already settled once; data is never delivered twice for one payment'), signed);
      }
      return settle(receipt, source);
    }, async (e) => {
      const signed = await signedP;
      if (!signed || !state.matchTransfer || isPaymentError(e)) return refuseNow(e, signed);
      console.error(`[mpp] tempo broadcast error (${String((e && e.message) || e).split('\n')[0].slice(0, 120)}); checking ${signed.hash} on-chain`);
      let out;
      try { out = await recover(req, signed, inst, route, tc.credential.challenge); } catch (err) { out = { ok: false, reason: `recovery failed: ${String(err && err.message).slice(0, 120)}` }; }
      console.error(`[mpp] tempo recovery for ${signed.hash}: ${out.ok ? 'landed and verified, settled' : out.reason}`);
      if (!out.ok) return refuseNow(e, signed, out.reason);
      return settle({ method: 'tempo', status: 'success', timestamp: new Date().toISOString(), reference: signed.hash }, signed.from);
    });
    return res;
  };
}

// mppx's own payment errors (verification, replay, mismatch) are verdicts, not transport
// failures; they are refused at once, never recovered.
function isPaymentError(e) {
  if (state.PaymentError) return e instanceof state.PaymentError;
  return /PaymentError|VerificationFailed|Mismatch|InvalidChallenge|InvalidPayload|Malformed/.test(String((e && e.name) || ''));
}

// Poll for the receipt of exactly this signed transaction; re-send it once after 3 s.
async function recover(req, signed, inst, route, challenge) {
  const { pollMs, resendAfterMs, afterExpiryMs, capMs, noExpiryMs } = { ...RECOVERY, ...(state.recovery || {}) };
  const t0 = Date.now();
  // until the signed transaction can no longer land, never past the cap
  const deadline = signed.validBefore ? Math.min(signed.validBefore * 1000 + afterExpiryMs, t0 + capMs) : t0 + noExpiryMs;
  const windowMs = Math.max(0, deadline - t0);
  const expect = { hash: signed.hash, from: signed.from, currency: inst.address, recipient: state.recipient, units: route.units,
    realm: challenge && challenge.realm, challengeId: challenge && challenge.id };
  let resent = false; let i = 0;
  while (Date.now() < deadline) {
    const url = RECEIPT_RPCS[i++ % RECEIPT_RPCS.length];
    const r = await state.rpc(url, 'eth_getTransactionReceipt', [signed.hash]).catch(() => null);
    if (r && r.result) {
      const why = state.matchTransfer(r.result, expect);
      if (why) return { ok: false, reason: `the transaction landed but ${why}` };
      const won = await state.tryClaim(state.settled, signed.hash.toLowerCase(), Date.now() + SETTLED_TTL_MS);
      if (!won) return { ok: false, reason: 'this transaction was already settled (replay)' };
      return { ok: true };
    }
    if (!resent && Date.now() - t0 >= resendAfterMs) {
      resent = true;
      // "already known", nonce and expiry errors are expected here and ignored
      await state.rpc(RECEIPT_RPCS[0], 'eth_sendRawTransaction', [signed.canonical]).catch(() => null);
    }
    await new Promise((r2) => setTimeout(r2, pollMs));
  }
  return { ok: false, reason: `no receipt for ${signed.hash} within ${Math.round(windowMs / 1000)} s` };
}

async function jsonRpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.json();
}

// The signed transaction: signer, and the hash mppx broadcasts (keccak256 of the canonical
// re-serialization; nodes normalize signature encodings, mppx/dist/tempo/server/Charge.js).
const makeDecoder = (Transaction, keccak256) => async (serialized) => {
  const tx = Transaction.deserialize(serialized);
  const canonical = await Transaction.serialize(Transaction.deserialize(serialized));
  return { from: tx.from, hash: keccak256(canonical), canonical, validBefore: tx.validBefore != null ? Number(tx.validBefore) : null };
};

// What mppx's assertTransferLogs + assertChallengeBoundMemo require of a receipt for a
// charge with no request memo: a TransferWithMemo of this token, from the signer, to the
// recipient, for the exact units, whose memo is bound to this server and this challenge.
// Returns null when it matches, else the reason.
const makeMatcher = (parseEventLogs, Abis, Attribution) => (receipt, x) => {
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  if (!receipt || !(receipt.status === '0x1' || receipt.status === 'success')) return 'its receipt status is not success';
  if (!eq(receipt.transactionHash, x.hash)) return 'the receipt is for another transaction';
  let logs = [];
  try { logs = parseEventLogs({ abi: Abis.tip20, eventName: 'TransferWithMemo', logs: receipt.logs || [] }); } catch { logs = []; }
  const ok = logs.some((l) => eq(l.address, x.currency) && eq(l.args.from, x.from) && eq(l.args.to, x.recipient)
    && String(l.args.amount) === String(x.units)
    && Attribution.verifyServer(l.args.memo, x.realm) && Attribution.verifyChallengeBinding(l.args.memo, x.challengeId));
  return ok ? null : 'it carries no matching transfer (token, payer, recipient, amount, challenge-bound memo)';
};

module.exports = { init, gate, isReady: () => !!state, isTempoCredential: (req) => !!(state && tempoCredential(req)), TEMPO_CHAIN_ID, TOKENS, _usdToUnits: usdToUnits, _tokenAmount: tokenAmount,
  // tests only: run the gate against stand-in mppx instances
  _setStateForTest: (s) => { state = s; }, _makeDecoder: makeDecoder, _makeMatcher: makeMatcher, _loadDeps: loadDeps, RECOVERY, RECEIPT_RPCS };
