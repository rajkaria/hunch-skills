#!/usr/bin/env bash
#
# HUNCH BAZAAR: void a market you created, with a stated reason (a wallet proof;
# creator only).
# intent: void
#
# Instead of resolving, the creator can void the market any time before it is
# resolved (and before the 48h guarantee runs out). Every bettor is refunded
# their full stake with no fee. The reason (10-500 characters) is shown on the
# market, and the void is counted on the creator's public record. Final.
#
# Usage:
#   WALLET=0x... MARKET_ID=<id> NOTE='The source I named stopped publishing prices.' ./void.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to the creator 0x wallet}"
MARKET_ID="${MARKET_ID:?set MARKET_ID to the market id}"
NOTE="${NOTE:?set NOTE: why you are voiding (10-500 characters, shown on the market)}"
bz_require_wallet WALLET "$WALLET"
bz_require_market_id "$MARKET_ID"
NOTE_LENGTH="$(bz_text_length "$NOTE")"
[ "$NOTE_LENGTH" -ge 10 ] || bz_die "say why you are voiding: at least 10 characters (bettors will see it)"
[ "$NOTE_LENGTH" -le 500 ] || bz_die "keep the reason to 500 characters or fewer"

bz_say "read the market"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}"
bz_expect 200
CARD="${BZ_TMP}/card.json"
cp "$BZ_RESPONSE" "$CARD"
MARKET_ID="$(jq -r '.market.id' "$CARD")"
[ "$(bz_lower "$(jq -r '.creator.wallet // empty' "$CARD")")" = "$(bz_lower "$WALLET")" ] ||
  bz_die "only the creator can void this market: $(jq -r '(.creator.handle // null | if . then "@" + . else null end) // .creator.wallet // "its creator"' "$CARD")"
case "$(jq -r '.market.state' "$CARD")" in
  open | closed) ;;
  *) bz_die "this market is already $(jq -r '.market.state' "$CARD")" ;;
esac

WALLET_JSON="$(bz_json "$WALLET")"
NOTE_JSON="$(bz_json "$NOTE")"

bz_say "void, refunding every bettor in full"
# contract: POST /api/bazaar/v1/markets/${MARKET_ID}/void proof=void_market market=${MARKET_ID}
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON},
  "note": ${NOTE_JSON}
}
JSON
)
bz_post_signed void_market "${MARKET_ID}" "/api/bazaar/v1/markets/${MARKET_ID}/void" "$BODY"
bz_expect 200
jq '{marketId, voided, reason, note, refunded, refunds: [.refunds[]? | .amount.amount],
  fees: {total: .fees.total.amount}}' "$BZ_RESPONSE"

bz_say "result to post"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}/results
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}/results"
bz_expect 200
jq '{announcement, void}' "$BZ_RESPONSE"
