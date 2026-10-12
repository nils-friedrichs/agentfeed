#!/bin/bash
# ops/release-proofs-solana.sh — the release's paid proof calls over x402 on Solana (2026-10-12).
#
#   cd /opt/agentfeed && bash ops/release-proofs-solana.sh            pays, from payer-wallet.json (Gack9)
#   DRY_RUN=1 bash ops/release-proofs-solana.sh                       never pays: unpaid 402 checks only
#   PAYER=/path/to/keypair.json bash ops/release-proofs-solana.sh     another payer (an unfunded one cannot pay)
#
# Eight calls: honeypot-check on BSC and base-launches (the R3/R4 routes), the five path-param
# routes Bazaar drops ~Oct 25 without a fresh settle, and hl-whales (new, for its first Bazaar
# record). Before anything is signed, every route's unpaid 402 is read and its Solana accept must
# pay the treasury 4a8o…CJ7 exactly the manifest price; one mismatch and nothing is paid. Then
# each call runs through test-client.mjs; the first status other than 200, or a 200 without a
# settlement transaction, stops the run. Prints route, status and settlement tx per call, then
# the total. Gack9 is in OWN_WALLETS: these payments are QA, not revenue.
set -uo pipefail
cd "$(dirname "$0")/.."
ORIGIN=https://x402.ochinimus.app
PAYER=${PAYER:-./payer-wallet.json}
TREASURY=4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7
ROUTES=(
  "/api/honeypot-check?chain=bsc&token=0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"
  "/api/base-launches?limit=3"
  "/api/token-metadata/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
  "/api/wallet-activity/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu"
  "/api/token-holders/MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey"
  "/api/token-risk/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
  "/api/wallet-holdings/Gack9UtqfeZxFA1LqeqjLgC3JGuD7rS6CsSHKoXsD4Tu"
  "/api/hl-whales?coin=ETH&top=5"
)

# 1. Guard: every 402 pays the treasury the manifest price. Prints "<route> <usd>" per line.
PLAN=$(ORIGIN=$ORIGIN TREASURY=$TREASURY node --input-type=module - "${ROUTES[@]}" <<'EOF'
const { ORIGIN, TREASURY } = process.env;
const wk = await (await fetch(`${ORIGIN}/.well-known/x402.json`)).json();
const price = (p) => { const r = wk.resources.find((x) => new RegExp('^' + new URL(x.resource).pathname.replace(/:[A-Za-z_]+/g, '[^/]+') + '$').test(p)); return r ? Number(r.price_usd) : null; };
let bad = 0;
for (const route of process.argv.slice(2)) {
  const res = await fetch(ORIGIN + route);
  const pr = res.headers.get('payment-required');
  const usd = price(route.split('?')[0]);
  const sol = pr ? JSON.parse(Buffer.from(pr, 'base64').toString()).accepts.find((a) => a.network.startsWith('solana:')) : null;
  const ok = res.status === 402 && sol && sol.payTo === TREASURY && usd != null && sol.amount === String(Math.round(usd * 1e6));
  if (!ok) { bad++; console.error(`GUARD FAIL ${route}: status ${res.status}, payTo ${sol && sol.payTo}, amount ${sol && sol.amount}, manifest $${usd}`); }
  console.log(`${route} ${usd}`);
}
if (bad) process.exit(3);
EOF
) || { echo "guard failed: nothing was paid"; exit 3; }

TOTAL=$(echo "$PLAN" | awk '{s+=$2} END {printf "%.3f", s}')
echo "payer file: $PAYER"
echo "guard OK: ${#ROUTES[@]} routes pay $TREASURY the manifest price; planned total \$$TOTAL"
if [ "${DRY_RUN:-0}" = "1" ]; then echo "$PLAN" | sed 's/^/  would pay  /'; echo "DRY_RUN=1: nothing paid"; exit 0; fi

# 2. Pay, one by one; stop at the first failure.
PAID=0; N=0
while read -r ROUTE USD; do
  OUT=$(node test-client.mjs "$ORIGIN$ROUTE" "$PAYER" 2>&1)
  STATUS=$(echo "$OUT" | sed -n 's/^status: \([0-9]*\).*/\1/p' | head -1)
  TX=$(echo "$OUT" | sed -n 's/.*"transaction": "\([^"]*\)".*/\1/p' | head -1)
  printf '%-75s status %s  tx %s\n' "$ROUTE" "${STATUS:-none}" "${TX:-none}"
  if [ "$STATUS" != "200" ] || [ -z "$TX" ]; then
    echo "STOPPED at $ROUTE. Client output:"; echo "$OUT" | head -25
    echo "paid $N calls, \$$(printf '%.3f' "$PAID")"; exit 1
  fi
  N=$((N + 1)); PAID=$(awk -v a="$PAID" -v b="$USD" 'BEGIN {print a + b}')
done <<< "$PLAN"
echo "done: $N calls settled, total \$$(printf '%.3f' "$PAID")"
