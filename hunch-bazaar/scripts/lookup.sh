#!/usr/bin/env bash
#
# HUNCH BAZAAR: open one market from whatever the user pasted (read-only).
# intent: odds
#
# REF is a bazaar.playhunch.xyz link (/markets, /quick or /embed, with or without
# https:// and ?ref=), a market id, or a private link slug. The API decides
# whether the market exists: a miss is a 404, never a guess. The card carries
# odds AND pool size per outcome, who settles it with their record line, their
# own position, the auto-refund instant, a ready-to-post share line, and for a
# shared link the referralCode to send as REF_CODE on a bet.
#
# Usage:
#   REF="https://bazaar.playhunch.xyz/markets/<id>" ./lookup.sh
#   REF=<id> WALLET=0x... ./lookup.sh      # adds your own bets
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

REF="${REF:?set REF to a Bazaar link, market id or private slug}"
case "$REF" in
  *[[:space:]]*) bz_die "REF must be one link or id" ;;
esac
REF_ENC="$(bz_uri "$REF")"
QS=""
if [ -n "${WALLET:-}" ]; then
  bz_require_wallet WALLET "$WALLET"
  QS="&wallet=${WALLET}"
fi

bz_say "market card: ${REF}"
# contract: GET /api/bazaar/v1/markets/lookup?ref=${REF_ENC}${QS}
bz_http GET "/api/bazaar/v1/markets/lookup?ref=${REF_ENC}${QS}"
bz_expect 200
jq -f "${BZ_LIB_DIR}/card.jq" "$BZ_RESPONSE"
