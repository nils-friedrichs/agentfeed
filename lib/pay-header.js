// lib/pay-header.js: read an x402 payment header the way x402 core reads it (R19c, 21 Oct 2026).
//
// @x402/core decodes PAYMENT-SIGNATURE with decodePaymentSignatureHeader (atob + TextDecoder('utf-8'), which drops a leading UTF-8 BOM, behind a
// base64 shape check). AgentFeed's own decoders used Buffer + JSON.parse, which keeps the BOM and throws: the same bytes settled in x402 and read as
// "no payment" here. Everything AgentFeed decodes from a payment header (the accepted requirement, the paid network, an X-PAYMENT carrying a v2
// payload) goes through this one function, so the two read the same bytes. null for anything that does not decode to an object.
'use strict';
const { decodePaymentSignatureHeader } = require('@x402/core/http');

function decodePaymentHeader(raw) {
  try {
    if (typeof raw !== 'string' || !raw) return null;
    const p = decodePaymentSignatureHeader(raw);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

module.exports = { decodePaymentHeader };
