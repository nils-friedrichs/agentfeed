// lib/batch-claim-core.js — the pure parts of ops/batch-claim.js, kept apart so a test can run them
// without a facilitator or a chain (test/r8.test.js).
//
// What the CDP facilitator does with batch-settlement money, in the order it happens:
//   claim   the channel's signed vouchers are redeemed on-chain: channel balance -> the receiver's
//           claimed-but-unsettled bucket (contract.receivers(receiver, token).totalClaimed)
//   settle  that bucket is swept to the receiver (.totalSettled); the contract function is
//           permissionless, the facilitator's sweep is refused below a minimum it does not publish
// CDP's error table says only: amount_too_low = "The payment is below the minimum amount the facilitator
// will settle." (docs.cdp.coinbase.com/x402/support/troubleshooting). The first live refusal (13 Oct 2026,
// Base, 0.0025 USDC) came from the settle step: the claim had already landed on-chain. So the job keeps
// the largest amount each step has refused; the minimum is above that.
'use strict';

/** A CDP refusal of a claim or settle as below its minimum. @x402/core's SettleError carries the
 *  facilitator's reason as errorReason (its message is the reason, or "reason: detail"); the message is
 *  the fallback for an error that was wrapped on the way up. */
function isBelowMinimum(e) {
  if (!e) return false;
  if (e.errorReason === 'amount_too_low') return true;
  return /^amount_too_low(\b|:)/.test(String(e.message || ''));
}

/** The facilitator saying there is nothing claimed-and-unsettled to sweep (x402 spec error invalid_batch_settlement_evm_nothing_to_settle):
 *  the bucket was already settled, by this job's earlier run or by anyone (settle is permissionless). Not a failure either. */
function isNothingToSettle(e) {
  if (!e) return false;
  return e.errorReason === 'invalid_batch_settlement_evm_nothing_to_settle' || /^invalid_batch_settlement_evm_nothing_to_settle(\b|:)/.test(String(e.message || ''));
}

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v || 0));
const maxBig = (a, b) => (b > a ? b : a);
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The per-network record the claim job leaves in batch-claim-state.json for the watchdog.
 * Amounts are atomic USDC (6 decimals) as JSON numbers, so the watchdog can compare them as integers.
 *
 * prev  the previous record or undefined
 * obs   { unclaimed: bigint, unsettled: bigint|null (null = could not be read),
 *         claimRefused: bigint|null, settleRefused: bigint|null, settledOk: bigint|null }
 *       claimRefused / settleRefused: the amount the facilitator refused as below its minimum this run;
 *       settledOk: the amount a settle moved this run
 *       claimRefused is only ever the owed amount of a claim that went to the facilitator ALONE (one channel); a refused batch of several
 *       channels says nothing about any one of them and is never recorded here, or a dust channel would hide real unclaimed value.
 *       claimBatchRefused: the total of a refused batch of several channels. It is used ONLY to decide whether to ask again (the job
 *       does not repeat a question it has just had answered); the watchdog never reads it, so it cannot hide unclaimed value
 *       claimAccepted: the smallest owed amount a single-channel claim carried this run
 *       atRisk: [{ owed: bigint, initiatedAt: epoch s }] channels that still hold unclaimed value while their payer's timed
 *       withdrawal is pending on-chain
 */
function nextNetworkState(prev, obs, nowIso) {
  prev = prev || {};
  const claimRefused = maxBig(big(prev.claim_refused_atomic), obs.claimRefused == null ? 0n : big(obs.claimRefused));
  const settleRefused = maxBig(big(prev.settle_refused_atomic), obs.settleRefused == null ? 0n : big(obs.settleRefused));
  const claimBatchRefused = maxBig(big(prev.claim_batch_refused_atomic), obs.claimBatchRefused == null ? 0n : big(obs.claimBatchRefused));
  const prevClaimOk = prev.claim_accepted_min_atomic == null ? null : big(prev.claim_accepted_min_atomic);
  const claimOk = obs.claimAccepted == null ? null : big(obs.claimAccepted);
  const claimAcceptedMin = claimOk == null ? prevClaimOk : (prevClaimOk == null || claimOk < prevClaimOk ? claimOk : prevClaimOk);
  const settledOk = obs.settledOk == null ? null : big(obs.settledOk);
  const prevOk = prev.settle_accepted_min_atomic == null ? null : big(prev.settle_accepted_min_atomic);
  const acceptedMin = settledOk == null ? prevOk : (prevOk == null || settledOk < prevOk ? settledOk : prevOk);
  const unclaimed = big(obs.unclaimed);
  // unsettled null = the chain read failed: keep what was known rather than pretending it is zero
  const unsettled = obs.unsettled == null ? (prev.unsettled_atomic == null ? null : big(prev.unsettled_atomic)) : big(obs.unsettled);
  const since = (now, prevSince) => (now > 0n ? (prevSince || nowIso) : null);
  return {
    at: nowIso,
    unclaimed_atomic: num(unclaimed),
    unclaimed_since: since(unclaimed, prev.unclaimed_since),
    unsettled_atomic: num(unsettled),
    unsettled_since: unsettled == null ? (prev.unsettled_since || null) : since(unsettled, prev.unsettled_since),
    at_risk_count: (obs.atRisk || []).length,
    at_risk_owed_atomic: num((obs.atRisk || []).reduce((a, r) => a + big(r.owed), 0n)),
    at_risk_initiated_at: (obs.atRisk || []).length ? Math.min(...obs.atRisk.map((r) => r.initiatedAt)) : null,
    claim_refused_atomic: num(claimRefused),
    // when a claim was last refused: the job does not ask again for an amount at or below the refusal until this is old (REPROBE_MS)
    claim_refused_at: obs.claimRefused == null && obs.claimBatchRefused == null ? (prev.claim_refused_at || null) : nowIso,
    claim_batch_refused_atomic: num(claimBatchRefused),
    claim_accepted_min_atomic: num(claimAcceptedMin),
    settle_refused_atomic: num(settleRefused),
    settle_accepted_min_atomic: num(acceptedMin),
  };
}

module.exports = { isBelowMinimum, isNothingToSettle, nextNetworkState };
