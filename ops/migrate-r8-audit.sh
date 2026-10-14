#!/bin/bash
# ops/migrate-r8-audit.sh — one time (13 Oct 2026, R8), safe to run again: it only changes rows that still need it.
#   1. every EVM payer in calls.payer_wallet becomes lower-case (lib/audit.js: one spelling per payer; Solana and Algorand addresses
#      are case-sensitive and not touched)
#   2. the rows of the batch-settlement / Circle Gateway proofs (get_eth_price, ids in AMT_IDS: P2 11976-11980, P3 11981, the top-up
#      11993/11995/11996/11998/11999, the through-a-claim confirmation 12021-12029) were logged at the list price $0.001 but charged $0.0005 each; amount_usdc becomes what was charged
#      (lib/audit.js settledUsd does this for new rows from the 14 Oct restart on). Rows written between now and that restart by a
#      batch or Gateway payer are added to AMT_IDS by hand after looking at them: the table alone cannot tell the tier.
# The table is backed up first (sqlite online backup, integrity-checked), the changes run in one transaction, and nothing is
# committed unless the counts match what was read before.
#   cd /opt/agentfeed && bash ops/migrate-r8-audit.sh            dry run: what would change, nothing written
#   cd /opt/agentfeed && bash ops/migrate-r8-audit.sh --apply    back up, migrate, verify
# AF_DB and BACKUP_DIR are test seams; AMT_IDS=11976,... overrides the row list.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${AF_DB:-agentfeed.db}
BACKUP_DIR=${BACKUP_DIR:-/opt/backups}
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
q() { sqlite3 -readonly -cmd '.timeout 10000' "$DB" "$1"; }

# an EVM address: 0x + 40 hex digits (GLOB cannot count, so length and a no-non-hex test together)
EVM="payer_wallet GLOB '0x*' AND length(payer_wallet) = 42 AND payer_wallet NOT GLOB '0x*[^0-9A-Fa-f]*'"
MIXED="$EVM AND payer_wallet <> lower(payer_wallet)"
AMT_IDS=${AMT_IDS:-11976,11977,11978,11979,11980,11981,11993,11995,11996,11998,11999,12021,12022,12023,12024,12025,12026,12027,12028,12029}
AMT="id IN ($AMT_IDS) AND tool = 'get_eth_price' AND status = 'paid' AND amount_usdc = 0.001"

n_mixed=$(q "SELECT COUNT(*) FROM calls WHERE $MIXED;")
n_amt=$(q "SELECT COUNT(*) FROM calls WHERE $AMT;")
n_ids=$(echo "$AMT_IDS" | tr ',' '\n' | wc -l)
echo "before: $n_mixed rows with a mixed-case EVM payer; $n_amt of the $n_ids proof rows still at the list price"
echo "        distinct paid payers: raw $(q "SELECT COUNT(DISTINCT payer_wallet) FROM calls WHERE status = 'paid';"), normalized $(q "SELECT COUNT(DISTINCT CASE WHEN $EVM THEN lower(payer_wallet) ELSE payer_wallet END) FROM calls WHERE status = 'paid';")"
q "SELECT id, status, amount_usdc, payer_wallet FROM calls WHERE id IN ($AMT_IDS) ORDER BY id;" | sed 's/^/        row /'
if [ "$APPLY" != 1 ]; then echo "dry run: nothing written (add --apply)"; exit 0; fi
if [ "$n_mixed" = 0 ] && [ "$n_amt" = 0 ]; then echo "nothing to change"; exit 0; fi
[ "$n_amt" -le "$n_ids" ] || { echo "ABORT: more rows at the list price ($n_amt) than ids listed ($n_ids)"; exit 1; }

mkdir -p "$BACKUP_DIR"
BK="$BACKUP_DIR/agentfeed-pre-r8-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 "$DB" ".timeout 10000" ".backup '$BK'"
[ "$(sqlite3 -readonly "$BK" 'PRAGMA integrity_check;')" = ok ] || { echo "ABORT: backup failed its integrity check ($BK)"; exit 1; }
b_rows=$(sqlite3 -readonly "$BK" 'SELECT COUNT(*) FROM calls;')
echo "backup: $BK ($(stat -c %s "$BK") bytes, $b_rows rows, integrity ok)"

out=$(sqlite3 "$DB" <<SQL
.timeout 10000
BEGIN IMMEDIATE;
UPDATE calls SET payer_wallet = lower(payer_wallet) WHERE $MIXED;
SELECT 'payers lower-cased: ' || changes();
UPDATE calls SET amount_usdc = 0.0005 WHERE $AMT;
SELECT 'amounts corrected: ' || changes();
COMMIT;
SQL
)
echo "$out"
echo "$out" | grep -q "amounts corrected: $n_amt\$" || { echo "UNEXPECTED amount count; the backup is $BK"; exit 1; }
echo "after:  $(q "SELECT COUNT(*) FROM calls WHERE $MIXED;") mixed-case EVM payers left; distinct paid payers $(q "SELECT COUNT(DISTINCT payer_wallet) FROM calls WHERE status = 'paid';")"
q "SELECT id, status, amount_usdc, payer_wallet FROM calls WHERE id IN ($AMT_IDS) ORDER BY id;" | sed 's/^/        row /'
echo "done; to undo: stop writers, copy $BK over $DB (rows written since are not in it)"
