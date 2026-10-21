// lib/audit.js — two facts the audit table (agentfeed.db `calls`) must get right: who paid, and what was charged (R8, 13 Oct 2026).
//
// PAYER. An EVM address is one payer however its case arrives. The exact rails carry it checksummed, the batch-settlement and
// Circle Gateway tiers lower-case, so one wallet showed up as two payers (0xFEfF... and 0xfeff...) in every count that groups by
// payer, and an own-wallet list written in one case missed the other. The table keeps ONE spelling, lower-case, written by
// db.js logCall; readers that compare against a list (ops/af-digest.js, /opt/afwatch/afwatch.js) normalize the list the same way.
// Solana and Algorand addresses are case-sensitive and are left exactly as they came.
//
// AMOUNT. `amount_usdc` was the route's LIST price on every paid row. The high-frequency tier (batch-settlement vouchers, Circle
// Gateway) charges half of it, minimum $0.0005 (lib/hf.js hfUsd), so those rows overstated revenue up to 2x. What was charged is
// the `amount` of the requirement the payer accepted (PAYMENT-SIGNATURE `accepted`, atomic USDC, 6 decimals): the x402 middleware
// only lets a handler run after `accepted` matched one of the requirements this server offered, so it is the settled price and
// not the caller's claim.
'use strict';

const { decodePaymentHeader } = require('./pay-header');

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The one stored spelling of a payer: lower-case for an EVM address, anything else as it came, null for nothing. */
function normPayer(w) {
  if (w === undefined || w === null || w === '') return null;
  const s = String(w);
  return EVM_ADDRESS.test(s) ? s.toLowerCase() : s;
}

/**
 * The accepted requirement inside an x402 v2 payment header (PAYMENT-SIGNATURE, base64 JSON), or null. Read with x402's own decoder (R19c), so a BOM
 * or any other shape core accepts is read the same here. It is the BUYER'S claim: since R19b it is not used for the amount a row logs (lib/tool.js).
 */
function acceptedOf(header) {
  const p = decodePaymentHeader(header);
  return p && typeof p.accepted === 'object' && p.accepted ? p.accepted : null;
}

/**
 * USD charged for a paid request. `accepted` is the requirement the payer accepted (or null: x402 v1, MPP and anything unreadable
 * were always charged the list price), `listUsd` the route's list price. An amount above the list price is not believed.
 */
function settledUsd(accepted, listUsd) {
  const list = Number(listUsd);
  const atomic = accepted && typeof accepted.amount === 'string' && /^[0-9]{1,12}$/.test(accepted.amount) ? Number(accepted.amount) : NaN;
  const usd = atomic / 1e6;
  if (Number.isFinite(usd) && usd > 0 && (!(list > 0) || usd <= list * 1.000001)) return Math.round(usd * 1e6) / 1e6;
  return listUsd === undefined ? null : listUsd;
}

module.exports = { normPayer, acceptedOf, settledUsd, EVM_ADDRESS };
