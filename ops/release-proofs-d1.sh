#!/bin/bash
# ops/release-proofs-d1.sh — the R6 D1 live proof, one command, at no cost when it passes (R7).
#   cd /opt/agentfeed && bash ops/release-proofs-d1.sh          one PAID request to /api/price with an unsupported symbol
#   DRY_RUN=1 bash ops/release-proofs-d1.sh                     never pays: the unpaid 402 check only
#   (AF_DB and D1_CLIENT are test seams: another audit database, another client command)
# The payer is payer-wallet.json (Gack9, QA, in OWN_WALLETS). The request carries a real x402 payment for the route's
# $0.001; the route must answer 400 before anything settles, so PASS = HTTP 400, no transaction in the client output,
# no 'paid' row in the audit table and the 400 itself recorded there as a 'bad_request' row. If it settles instead, the cost is
# $0.001 and the result is FAIL.
set -uo pipefail
cd "$(dirname "$0")/.."
ORIGIN=https://x402.ochinimus.app
PAYER=${PAYER:-./payer-wallet.json}
TREASURY=4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7
SYMBOL=${SYMBOL:-DOGE}
ROUTE="/api/price?symbol=$SYMBOL"

# 1. Guard: the unpaid request is a 402 that pays the treasury the manifest price, so a paid retry could only ever go there.
node --input-type=module - "$ORIGIN$ROUTE" "$TREASURY" <<'EOF2' || { echo "guard failed: nothing was paid"; exit 3; }
const [url, treasury] = process.argv.slice(2);
const res = await fetch(url);
const pr = res.headers.get('payment-required');
const sol = pr ? JSON.parse(Buffer.from(pr, 'base64').toString()).accepts.find((a) => a.network.startsWith('solana:')) : null;
if (!(res.status === 402 && sol && sol.payTo === treasury && sol.amount === '1000')) { console.error(`GUARD FAIL: status ${res.status}, payTo ${sol && sol.payTo}, amount ${sol && sol.amount}`); process.exit(3); }
console.log(`guard OK: unpaid ${url} -> 402, pays ${treasury} ${Number(sol.amount) / 1e6} USDC`);
EOF2
if [ "${DRY_RUN:-0}" = "1" ]; then echo "DRY_RUN=1: nothing paid"; exit 0; fi

# 2. The paid request. T0 is epoch ms from node: the VPS `date` is uutils coreutils, whose %3N prints all nine nanosecond digits, so
#    `date +%s%3N` gave a 19-digit "ms" value that no audit row's ts can reach and both audit counts below read 0 whatever the table held.
T0=$(node -e 'console.log(Date.now())')
case "$T0" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "T0 is not an epoch-ms value ($T0): nothing was paid"; exit 3 ;; esac
OUT=$(${D1_CLIENT:-node test-client.mjs} "$ORIGIN$ROUTE" "$PAYER" 2>&1)
STATUS=$(echo "$OUT" | sed -n 's/^status: \([0-9]*\).*/\1/p' | head -1)
HAS_TX=$(echo "$OUT" | grep -c '"transaction"')
echo "$OUT" | sed -n '1,12p' | cut -c1-240

# 3. The audit table. The 400 must show up as a 'bad_request' row (the audit log flushes every 2 s, so wait up to 10 s): that row is the
#    control that this query can see the request at all, so "no paid row" below means something. Any 'paid' row since the request fails.
BADROWS=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  BADROWS=$(sqlite3 -readonly "${AF_DB:-agentfeed.db}" "SELECT COUNT(*) FROM calls WHERE tool = 'get_spot' AND status = 'bad_request' AND ts >= $T0;" 2>/dev/null)
  [ "${BADROWS:-0}" -ge 1 ] 2>/dev/null && break
  sleep 1
done
PAIDROWS=$(sqlite3 -readonly "${AF_DB:-agentfeed.db}" "SELECT COUNT(*) FROM calls WHERE tool = 'get_spot' AND status = 'paid' AND ts >= $T0;" 2>/dev/null)
echo "client status: ${STATUS:-none} | settlement transaction in the output: $HAS_TX | paid rows since the request: ${PAIDROWS:-?} | bad_request rows since the request: ${BADROWS:-?}"
if [ "$STATUS" = "400" ] && [ "$HAS_TX" = "0" ] && [ "$PAIDROWS" = "0" ] && [ "${BADROWS:-0}" -ge 1 ] 2>/dev/null; then
  echo "PASS: HTTP 400, no settlement (no transaction, no paid row), and the 400 is on record as a bad_request row"; exit 0
fi
echo "FAIL: expected HTTP 400, no transaction, no paid row and one bad_request row"; exit 1
