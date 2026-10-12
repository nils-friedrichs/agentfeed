#!/bin/bash
# ops/release-proofs-evm.sh — the release's Tempo (MPP) and Arc (x402) proof calls (2026-10-12).
#
#   cd /opt/agentfeed && bash ops/release-proofs-evm.sh     creates the payer key if missing, reads balances,
#                                                           pays only on a funded chain
#   PROOF_KEY=/path/key bash ops/release-proofs-evm.sh      another key file (an unfunded one cannot pay)
#   FORCE_TRY=1 ...                                         also attempt unfunded chains (they fail at funds;
#                                                           used to test the wiring without paying)
#   ONLY=tempo | ONLY=arc ...                               run one chain only
#
# Payer key: /root/.config/agentfeed/proof-payer-evm.key (mode 600). Created here if missing; only
# the address is ever printed. Fund it via relay.link (AF-release-his-steps-20261012.md).
# Each call costs $0.001 on /api/eth-price. Before paying, the unpaid 402 is checked: the tempo
# challenge must name the Base treasury 0x22DB…76e6 and 0.001, the Arc accept must pay the Arc
# payTo 0x0Cf4…2f83 exactly 1000 base units; a mismatch pays nothing on that chain.
set -uo pipefail
cd "$(dirname "$0")/.."
KEY=${PROOF_KEY:-/root/.config/agentfeed/proof-payer-evm.key}
URL=https://x402.ochinimus.app/api/eth-price
OUSD=0x20c0000000000000000000006a37da5c996874be
USDCE=0x20c000000000000000000000b9537d11c60e8b50

if [ ! -f "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  F="$KEY" node --input-type=module -e "import fs from 'node:fs'; import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'; const k=generatePrivateKey(); fs.writeFileSync(process.env.F,k+'\n',{mode:0o600,flag:'wx'}); console.log('created payer key '+process.env.F+' (600), address '+privateKeyToAccount(k).address)" || exit 2
fi

# Balances + 402 guards in one pass. Prints shell assignments; never prints the key.
eval "$(KEY="$KEY" URL="$URL" OUSD=$OUSD USDCE=$USDCE node --input-type=module <<'EOF'
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
const { KEY, URL, OUSD, USDCE } = process.env;
const addr = privateKeyToAccount(fs.readFileSync(KEY, 'utf8').trim()).address;
const call = async (rpc, to) => { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0') }, 'latest'] }) }).then((x) => x.json()); if (r.error) throw new Error(rpc + ' ' + r.error.message); return Number(BigInt(r.result)) / 1e6; };
const [ousd, usdce, arc] = await Promise.all([call('https://rpc.tempo.xyz', OUSD), call('https://rpc.tempo.xyz', USDCE), call('https://rpc.mainnet.arc.io', '0x3600000000000000000000000000000000000000')]);
const res = await fetch(URL);
const pr = JSON.parse(Buffer.from(res.headers.get('payment-required') || '', 'base64').toString() || 'null');
const a = pr && pr.accepts.find((x) => x.network === 'eip155:5042');
const arcOk = res.status === 402 && a && a.payTo === '0x0Cf44185564F2b72E291050DC79E578429E52f83' && a.amount === '1000';
const www = res.headers.get('www-authenticate') || '';
const decoded = [...www.matchAll(/request="([^"]+)"/g)].map((m) => { try { return JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { return null; } }).filter(Boolean);
const tempoOk = decoded.some((d) => String(d.recipient).toLowerCase() === '0x22db3a9686ee5261e7bf3ed4f91277232e8076e6' && String(d.amount) === '1000');
console.log(`ADDR=${addr} OUSD_BAL=${ousd} USDCE_BAL=${usdce} ARC_BAL=${arc} ARC_GUARD=${arcOk ? 1 : 0} TEMPO_GUARD=${tempoOk ? 1 : 0}`);
EOF
)" || { echo "balance or guard read failed: nothing paid"; exit 3; }

echo "payer $ADDR"
echo "Tempo: OUSD $OUSD_BAL, USDC.e $USDCE_BAL | Arc: USDC $ARC_BAL | 402 guards: tempo $TEMPO_GUARD, arc $ARC_GUARD"
DID=(); TODO=()
funded() { awk -v b="$1" 'BEGIN {exit !(b >= 0.003)}'; }

# Tempo (MPP tempo/charge, pull). OUSD is the first challenge; USDC.e needs --currency.
CUR=""
if funded "$OUSD_BAL"; then CUR=$OUSD; elif funded "$USDCE_BAL"; then CUR=$USDCE; fi
if [ "${ONLY:-tempo}" != "tempo" ]; then :
elif [ "$TEMPO_GUARD" != "1" ]; then TODO+=("tempo: 402 guard failed, not paid")
elif [ -n "$CUR" ] || [ "${FORCE_TRY:-0}" = "1" ]; then
  # the block before the call: a transfer is only ever looked for from here on
  FROM_BLOCK=$(curl -s -m 15 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' https://rpc.tempo.xyz | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')
  OUT=$(MPPX_PRIVATE_KEY=$(cat "$KEY") timeout 120 ./mpp/node_modules/.bin/mppx --protocol mpp -i ${CUR:+--currency $CUR} "$URL" 2>&1)
  # mppx -i prints the 402 challenge's status line first and the paid response's last
  if echo "$OUT" | command grep -qi '^payment-receipt:'; then DID+=("tempo: paid \$0.001 on $URL ($(echo "$OUT" | command grep -i '^HTTP/' | tail -1 | tr -d '\r'))")
    echo "$OUT" | command grep -i '^payment-receipt:' | cut -c1-200
  else TODO+=("tempo: call failed: $(echo "$OUT" | command grep -m1 -i 'message\|error' | cut -c1-200)")
    # A refused call can still have moved funds (12 Oct: rpc.tempo.xyz answered 502 to the server's
    # broadcast after the transfer had landed). Look for this payer's transfer to the treasury,
    # only in blocks from just before this call, so an older payment is never reported.
    LANDED=$([ -n "$FROM_BLOCK" ] && ADDR="$ADDR" FROM="$FROM_BLOCK" node --input-type=module -e "const R='https://rpc.tempo.xyz';const c=(m,p)=>fetch(R,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})}).then(r=>r.json());const pad=(a)=>'0x'+a.slice(2).toLowerCase().padStart(64,'0');const r=await c('eth_getLogs',[{fromBlock:process.env.FROM,toBlock:'latest',topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',pad(process.env.ADDR),pad('0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6')]}]);console.log((r.result||[]).map((l)=>l.transactionHash).join(' '))" 2>/dev/null)
    [ -n "$LANDED" ] && TODO+=("tempo: BUT the transfer to the treasury landed on-chain (paid, data withheld): $LANDED")
  fi
else TODO+=("tempo: unfunded (needs >= 0.003 OUSD or USDC.e at $ADDR)"); fi

# Arc (x402 exact, Circle Facilitator Service)
if [ "${ONLY:-arc}" != "arc" ]; then :
elif [ "$ARC_GUARD" != "1" ]; then TODO+=("arc: 402 guard failed, not paid")
elif funded "$ARC_BAL" || [ "${FORCE_TRY:-0}" = "1" ]; then
  OUT=$(timeout 120 node ops/pay-arc.mjs "$URL" "$KEY" 2>&1)
  if echo "$OUT" | command grep -q 'settled true'; then DID+=("arc: $(echo "$OUT" | command grep 'settled true' | head -1)")
  else TODO+=("arc: call failed: $(echo "$OUT" | command grep -m1 'status\|refused' | cut -c1-200); $(echo "$OUT" | command grep -m1 'refused' | cut -c1-120)"); fi
else TODO+=("arc: unfunded (needs >= 0.003 USDC on Arc at $ADDR)"); fi

echo "DID:"; for d in "${DID[@]:-}"; do [ -n "$d" ] && echo "  $d"; done
echo "STILL TO DO:"; for t in "${TODO[@]:-}"; do [ -n "$t" ] && echo "  $t"; done
[ ${#TODO[@]} -eq 0 ]
