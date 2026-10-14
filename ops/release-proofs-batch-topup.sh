#!/bin/bash
# ops/release-proofs-batch-topup.sh — finish the batch-settlement proof (R8): more calls on the SAME channel, each followed by a claim and
# a settle, until everything is claimed and settled or the calls run out. P2 (13 Oct) paid 5 calls from 0xFEfF and the claim landed
# but the settle was refused as amount_too_low a fraction of a second before the claim's block (the same 0.0025 USDC settled 20 min
# later). This answers what is left: do a claim and a settle go through at the smallest billable amount, $0.0005?
#   cd /opt/agentfeed && bash ops/release-proofs-batch-topup.sh      pays up to 5 calls of $0.0005 over batch-settlement from the P2 payer
#   DRY_RUN=1 bash ops/release-proofs-batch-topup.sh                  never signs: the channel as the chain sees it, the payer's balance
#   CALLS=n PROOF_KEY=/path/key PROOF_URL=https://... as needed
# The channel opened by P2 holds 0.0025 USDC still usable (five more calls). The payer needs no ETH and no deposit for them; a sixth
# call would top the channel up by the route's minimum deposit ($0.005, one EIP-3009 authorization the facilitator submits), so CALLS
# above 5 needs that much USDC at the payer (0.019 on 13 Oct). After each call the real claim job runs (under the cron's lock), so
# a refusal is recorded exactly as in production (batch-claim-state.json, batch-claims.jsonl) and the loop stops at the first run
# that leaves nothing unclaimed and nothing unsettled. The payment goes from the payer to our own treasury.
# RESULT (run by Sergiu 13 Oct 06:41 UTC): claims of 0.0005 were refused as amount_too_low (calls 1, 3, 5), claims of 0.0010 went through and
# settled (calls 2, 4): CDP's claim minimum lies in (0.0005, 0.0010]. The loop therefore ran all five calls and left one 0.0005 voucher
# unclaimed on the channel, which is the expected end state, not a fault. See AF-R8-report-20261013.md.
set -uo pipefail
cd "$(dirname "$0")/.."
KEY=${PROOF_KEY:-/root/.config/agentfeed/payer-feff.key}
URL=${PROOF_URL:-https://x402.ochinimus.app/api/eth-price}
MAX=${CALLS:-5}
STATE=${BATCH_CLAIM_STATE:-batch-claim-state.json}
[ -f "$KEY" ] || { echo "no payer key at $KEY"; exit 2; }
echo "== before (the chain)"; node ops/batch-onchain.mjs || echo "(chain read failed; continuing)"
if [ "${DRY_RUN:-0}" = "1" ]; then node ops/proof-batch.mjs "$URL" "$KEY" 1 --dry; echo "DRY_RUN=1: nothing signed; would pay up to $MAX calls, each followed by a claim and settle run"; exit 0; fi
for i in $(seq 1 "$MAX"); do
  echo "== call $i of up to $MAX"
  node ops/proof-batch.mjs "$URL" "$KEY" 1 || { echo "STOPPED: the call did not pay; nothing further was signed"; exit 1; }
  sleep 2
  flock -w 300 /var/lock/batch-claim.lock node ops/batch-claim.js
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).networks["eip155:8453"] || {};
    const u = (x) => (x == null ? "?" : x / 1e6);
    console.log(`   record: unclaimed ${u(s.unclaimed_atomic)} | unsettled ${u(s.unsettled_atomic)} | claim refused up to ${u(s.claim_refused_atomic)} | settle refused up to ${u(s.settle_refused_atomic)} | smallest settle accepted ${s.settle_accepted_min_atomic == null ? "-" : u(s.settle_accepted_min_atomic)} USDC`);
    process.exit(s.unclaimed_atomic === 0 && s.unsettled_atomic === 0 ? 10 : 0);
  ' "$STATE"
  [ $? -eq 10 ] && { echo "   everything claimed and settled after call $i"; break; }
done
echo "== after (the chain)"; node ops/batch-onchain.mjs || echo "(chain read failed)"
echo "== what the job logged"; tail -n 8 batch-claims.jsonl | cut -c1-260
