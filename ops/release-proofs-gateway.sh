#!/bin/bash
# ops/release-proofs-gateway.sh — one Circle Gateway nanopayment on Base (R5 A2 proof), one command.
#   cd /opt/agentfeed && bash ops/release-proofs-gateway.sh        deposits 0.05 USDC into Gateway once, then pays once
#   DRY_RUN=1 bash ops/release-proofs-gateway.sh                   never signs: guard + balances only
#   NO_DEPOSIT=1 bash ops/release-proofs-gateway.sh                pays from an existing Gateway balance
# Payer: the proof payer key (0x05B38FF795A2d750788157f1119e5D403D8eF47a). It needs 0.05 USDC and a
# little ETH on Base for the approve + deposit transactions. The route is /api/eth-price, whose
# Gateway price is $0.0005. Withdrawals from our seller side: ops/gateway-withdraw.mjs.
set -uo pipefail
cd "$(dirname "$0")/.."
KEY=${PROOF_KEY:-/root/.config/agentfeed/proof-payer-evm.key}
URL=${PROOF_URL:-https://x402.ochinimus.app/api/eth-price}
[ -f "$KEY" ] || { echo "no payer key at $KEY"; exit 2; }
if [ "${DRY_RUN:-0}" = "1" ]; then exec node ops/proof-gateway.mjs "$URL" "$KEY" --deposit 0.05 --dry; fi
if [ "${NO_DEPOSIT:-0}" = "1" ]; then exec node ops/proof-gateway.mjs "$URL" "$KEY"; fi
exec node ops/proof-gateway.mjs "$URL" "$KEY" --deposit "${DEPOSIT:-0.05}"
