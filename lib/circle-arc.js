// lib/circle-arc.js — the Arc rail through Circle's Facilitator Service (R4, 2026-10-12).
//
// WHY A CLIENT OF ITS OWN. @x402/core's HTTPFacilitatorClient builds the request body
// itself and asks for auth headers without showing it, but Circle's keyless seller proof
// signs keccak256 of the exact raw body. So this client builds the body, signs, and posts.
// It implements the three methods x402ResourceServer calls: getSupported, verify, settle.
//
// ARC ONLY. Circle's /supported also lists Base and Polygon. x402ResourceServer keeps the
// first facilitator per (version, network, scheme) and CDP is first, but if CDP's
// /supported failed at boot Circle would silently take those networks over. getSupported
// therefore returns Arc kinds only, so Circle can never serve anything but Arc.
//
// AUTH. With CIRCLE_API_KEY: Bearer token (production; binds payTo to the Circle account).
// Without it: the keyless trial, a Facilitator-Seller-Proof envelope per request, an
// EIP-712 SellerRequest signed by the key that controls payTo (the dedicated Arc payTo key
// at ARC_PAYTO_KEY, never the treasury's). Spec: developers.circle.com/facilitator-service/
// sign-seller-proof. The trial's remaining allowance is not exposed by the API; when it is
// spent /settle answers 403 registration_required.
//
// PENDING. /settle answers HTTP 200 with success:false, errorReason settlement_pending and a
// settlement-status extension carrying paymentId. Circle: do not fulfill on pending. This
// client polls GET /status/{paymentId} a few times inside the request; completed becomes a
// normal success (the response is released), failed stays a failure, and anything still
// pending is appended to ARC_PENDING_LOG for ops/arc-reconcile.js and answered as a
// failure, so the data is withheld. Arc has instant finality, so pending should be rare.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ARC = { network: 'eip155:5042', chainId: 5042, usdc: '0x3600000000000000000000000000000000000000', extra: { name: 'USDC', version: '2' } };
const DEFAULT_URL = 'https://api.circle.com/v1/facilitator/x402';
const KEY_PATH = (env) => env.ARC_PAYTO_KEY || '/root/.config/agentfeed/arc-payto.key';

/** The Arc payTo address from its key file, or null when the rail is not configured. */
function arcPayTo(env = process.env) {
  if (String(env.X402_ARC || '').toLowerCase() === 'off') return null;
  try {
    const { privateKeyToAccount } = require('viem/accounts');
    const k = fs.readFileSync(KEY_PATH(env), 'utf8').trim();
    return privateKeyToAccount(k).address;
  } catch {
    return null;
  }
}

class CircleArcFacilitator {
  constructor({ env = process.env, fetchImpl = fetch, pollMs = 2000, polls = 3 } = {}) {
    const { privateKeyToAccount } = require('viem/accounts');
    this.url = (env.CIRCLE_FACILITATOR_URL || DEFAULT_URL).replace(/\/$/, '');
    this.apiKey = env.CIRCLE_API_KEY || '';
    this.account = privateKeyToAccount(fs.readFileSync(KEY_PATH(env), 'utf8').trim());
    this.payTo = this.account.address;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
    this.polls = polls;
    this.pendingLog = env.ARC_PENDING_LOG || path.join(__dirname, '..', 'arc-pending.jsonl');
    this.mode = this.apiKey ? 'api-key' : 'keyless-trial';
  }

  // EIP-712 SellerRequest, base64url envelope (Circle "Sign a seller proof").
  async sellerProof(purpose, method, body) {
    const { keccak256, toBytes, toHex } = require('viem');
    const issuedAt = Math.floor(Date.now() / 1000);
    const message = {
      purpose, method, bodyHash: keccak256(toBytes(body || '')), network: ARC.network, payTo: this.payTo,
      nonce: toHex(crypto.randomBytes(32)), issuedAt: BigInt(issuedAt), expiresAt: BigInt(issuedAt + 300),
    };
    const signature = await this.account.signTypedData({
      domain: { name: 'Circle Facilitator Seller Request', version: '1', chainId: ARC.chainId },
      types: { SellerRequest: [
        { name: 'purpose', type: 'string' }, { name: 'method', type: 'string' }, { name: 'bodyHash', type: 'bytes32' },
        { name: 'network', type: 'string' }, { name: 'payTo', type: 'address' }, { name: 'nonce', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint64' }, { name: 'expiresAt', type: 'uint64' },
      ] },
      primaryType: 'SellerRequest',
      message,
    });
    const envelope = { version: 1, signature, network: message.network, payTo: message.payTo, nonce: message.nonce, issuedAt, expiresAt: issuedAt + 300 };
    return Buffer.from(JSON.stringify(envelope)).toString('base64url');
  }

  async headers(purpose, method, body) {
    const h = { accept: 'application/json' };
    if (body != null) h['content-type'] = 'application/json';
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    else h['facilitator-seller-proof'] = await this.sellerProof(purpose, method, body);
    return h;
  }

  async call(purpose, method, url, bodyObj) {
    const body = bodyObj == null ? null : JSON.stringify(bodyObj);
    const r = await this.fetch(url, { method, headers: await this.headers(purpose, method, body), body: body == null ? undefined : body, signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* reported below */ }
    return { status: r.status, json, text };
  }

  async getSupported() {
    const r = await this.fetch(`${this.url}/supported`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Circle /supported ${r.status}`);
    const s = await r.json();
    return { ...s, kinds: (s.kinds || []).filter((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === ARC.network) };
  }

  body(paymentPayload, paymentRequirements) {
    const safe = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    return { x402Version: paymentPayload.x402Version, paymentPayload: safe(paymentPayload), paymentRequirements: safe(paymentRequirements) };
  }

  async verify(paymentPayload, paymentRequirements) {
    const { status, json, text } = await this.call('verify', 'POST', `${this.url}/verify`, this.body(paymentPayload, paymentRequirements));
    if (status === 200 && json && 'isValid' in json) return json;
    throw new Error(`Circle /verify ${status}: ${(json && (json.message || json.invalidReason)) || text.slice(0, 200)}`);
  }

  async settle(paymentPayload, paymentRequirements) {
    const { status, json, text } = await this.call('settle', 'POST', `${this.url}/settle`, this.body(paymentPayload, paymentRequirements));
    if (status !== 200 || !json || !('success' in json)) {
      const reason = json && Array.isArray(json.errors) && json.errors[0] ? json.errors[0].reason : null;
      throw new Error(`Circle /settle ${status}${reason ? ` ${reason}` : ''}: ${(json && json.message) || text.slice(0, 200)}`);
    }
    if (json.success || json.errorReason !== 'settlement_pending') return json;
    const st = json.extensions && json.extensions['settlement-status'];
    const paymentId = st && st.paymentId;
    if (!paymentId) return json;
    for (let i = 0; i < this.polls; i++) {
      await new Promise((res) => setTimeout(res, this.pollMs));
      const s = await this.status(paymentId).catch(() => null);
      if (s && s.status === 'completed') return { success: true, payer: s.payer || json.payer, transaction: s.transaction || '', network: s.network || ARC.network, amount: s.amount };
      if (s && s.status === 'failed') return { success: false, errorReason: 'settlement_failed', payer: json.payer, transaction: '', network: ARC.network };
    }
    // still pending: withhold, and leave it for reconciliation
    try { fs.appendFileSync(this.pendingLog, JSON.stringify({ at: new Date().toISOString(), paymentId, network: ARC.network, payTo: this.payTo, payer: json.payer || null, amount: paymentRequirements.amount, resource: (paymentPayload.resource && paymentPayload.resource.url) || null }) + '\n'); } catch { /* best effort */ }
    return json;
  }

  async status(paymentId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(paymentId))) throw new Error('bad paymentId');
    const { status, json, text } = await this.call('status', 'GET', `${this.url}/status/${paymentId}`, null);
    if (status !== 200 || !json) throw new Error(`Circle /status ${status}: ${text.slice(0, 200)}`);
    return json;
  }
}

module.exports = { ARC, CircleArcFacilitator, arcPayTo };
