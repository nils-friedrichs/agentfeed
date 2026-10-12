#!/bin/bash
# ops/release-proofs-batch.sh — the batch-settlement proof (R5 A1): a channel on Base from the
# proof payer, 5 calls on /api/eth-price at the batch price, then one claim.
#   cd /opt/agentfeed && bash ops/release-proofs-batch.sh        pays (needs ~0.01 USDC on Base at the payer)
#   DRY_RUN=1 bash ops/release-proofs-batch.sh                   never signs: guard + balances only
#   PROOF_KEY=/path/key bash ops/release-proofs-batch.sh         another payer
set -uo pipefail
cd "$(dirname "$0")/.."
KEY=${PROOF_KEY:-/root/.config/agentfeed/proof-payer-evm.key}
URL=${PROOF_URL:-https://x402.ochinimus.app/api/eth-price}
[ -f "$KEY" ] || { echo "no payer key at $KEY (run ops/release-proofs-evm.sh once to create it)"; exit 2; }
if [ "${DRY_RUN:-0}" = "1" ]; then node ops/proof-batch.mjs "$URL" "$KEY" 5 --dry; node ops/batch-claim.js --dry; exit $?; fi
node ops/proof-batch.mjs "$URL" "$KEY" 5 || { echo "STOPPED: calls did not all pay; no claim run"; exit 1; }
echo "claim:"
node ops/batch-claim.js
tail -3 batch-claims.jsonl 2>/dev/null
