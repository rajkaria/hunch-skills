#!/usr/bin/env bash
#
# HUNCH BAZAAR: the market card by id or private slug (read-only).
# intent: odds
#
# Odds AND pool size per outcome, bettors, close, resolve deadline, the
# auto-refund instant, who settles it with their record line and their own
# position. Odds come from money: an empty pool has none, never an even split.
# For a pasted link use lookup.sh.
#
# Usage:
#   MARKET_ID=<id> ./odds.sh
#   MARKET_ID=<id> WALLET=0x... ./odds.sh      # adds your own bets
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

MARKET_ID="${MARKET_ID:?set MARKET_ID to the market id or private slug}"
bz_require_market_id "$MARKET_ID"
QS=""
if [ -n "${WALLET:-}" ]; then
  bz_require_wallet WALLET "$WALLET"
  QS="?wallet=${WALLET}"
fi

bz_say "market card: ${MARKET_ID}"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}${QS}
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}${QS}"
bz_expect 200
jq -f "${BZ_LIB_DIR}/card.jq" "$BZ_RESPONSE"
