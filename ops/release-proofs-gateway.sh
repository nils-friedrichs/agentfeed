#!/bin/bash
# ops/release-proofs-gateway.sh — one Circle Gateway nanopayment (R5 A2 proof on Base; R7: on Arc, at cents), one command.
#   CHAIN=arc bash ops/release-proofs-gateway.sh        deposit sized from a live gas estimate, then pays once  (R7)
#   DRY_RUN=1 CHAIN=arc bash ops/release-proofs-gateway.sh      never signs: guard + balances + the sized deposit only
#   NO_DEPOSIT=1 CHAIN=arc bash ops/release-proofs-gateway.sh   pays from an existing Gateway balance
#   bash ops/release-proofs-gateway.sh                  CHAIN defaults to base: deposits 0.05 USDC once, then pays once
# Payer: the proof payer key (0x05B38FF795A2d750788157f1119e5D403D8eF47a). On Base it needs 0.05 USDC and a little
# ETH for the approve + deposit transactions; on Arc gas is paid in USDC, so ~0.057 USDC is enough (ops/proof-gateway.mjs
# `--deposit auto` keeps room for both transactions and a few payments). The route is /api/eth-price, whose Gateway
# price is $0.0005. Withdrawals from our seller side: ops/gateway-withdraw.mjs.
set -uo pipefail
cd "$(dirname "$0")/.."
export CHAIN=${CHAIN:-base}
KEY=${PROOF_KEY:-/root/.config/agentfeed/proof-payer-evm.key}
URL=${PROOF_URL:-https://x402.ochinimus.app/api/eth-price}
[ -f "$KEY" ] || { echo "no payer key at $KEY"; exit 2; }
case "$CHAIN" in base) DEF=0.05 ;; arc) DEF=auto ;; *) echo "CHAIN must be base or arc"; exit 2 ;; esac
if [ "${DRY_RUN:-0}" = "1" ]; then exec node ops/proof-gateway.mjs "$URL" "$KEY" --deposit "${DEPOSIT:-$DEF}" --dry; fi
if [ "${NO_DEPOSIT:-0}" = "1" ]; then exec node ops/proof-gateway.mjs "$URL" "$KEY"; fi
exec node ops/proof-gateway.mjs "$URL" "$KEY" --deposit "${DEPOSIT:-$DEF}"
