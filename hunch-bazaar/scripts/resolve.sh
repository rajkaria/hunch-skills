#!/usr/bin/env bash
#
# HUNCH BAZAAR: resolve a market you created (a wallet proof; creator only).
# intent: resolve
#
# Instant and final: winners are paid in the same call, net of the market's
# settlement fee. Only the creator's wallet can resolve (a proof from any other
# wallet is refused), from when Bazaar closes the market until 48h past its
# resolve deadline; after that every bettor is refunded instead. The script reads
# the market first (existence, creator, state and outcome keys come from the
# API), signs only a proof whose Intent is `resolve as "<that outcome>"`, then
# prints the ready-to-post result.
#
# Usage:
#   WALLET=0x... MARKET_ID=<id> OUTCOME=yes \
#     NOTE='CoinGecko closed ETH at 4,112 on Sep 19, 2026.' \
#     EVIDENCE_URL=https://www.coingecko.com/en/coins/ethereum/historical_data ./resolve.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to the creator 0x wallet}"
MARKET_ID="${MARKET_ID:?set MARKET_ID to the market id}"
OUTCOME="${OUTCOME:?set OUTCOME to the winning outcome key}"
NOTE="${NOTE:?set NOTE: what happened and where you checked (public)}"
EVIDENCE_URL="${EVIDENCE_URL:-}"
bz_require_wallet WALLET "$WALLET"
bz_require_market_id "$MARKET_ID"
bz_require_outcome "$OUTCOME"
[ "$(bz_text_length "$NOTE")" -ge 1 ] && [ "$(bz_text_length "$NOTE")" -le 2000 ] ||
  bz_die "NOTE must be 1-2000 characters"
if [ -n "$EVIDENCE_URL" ]; then bz_require_https_url EVIDENCE_URL "$EVIDENCE_URL"; fi

bz_say "read the market"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}"
bz_expect 200
CARD="${BZ_TMP}/card.json"
cp "$BZ_RESPONSE" "$CARD"
MARKET_ID="$(jq -r '.market.id' "$CARD")"
[ "$(bz_lower "$(jq -r '.creator.wallet // empty' "$CARD")")" = "$(bz_lower "$WALLET")" ] ||
  bz_die "only the creator can resolve this market: $(jq -r '(.creator.handle // null | if . then "@" + . else null end) // .creator.wallet // "its creator"' "$CARD")"
KEY="$(jq -r --arg o "$OUTCOME" '[.market.outcomeKeys[] | select(ascii_downcase == ($o | ascii_downcase))][0] // empty' "$CARD")"
[ -n "$KEY" ] || bz_die "\"${OUTCOME}\" is not an outcome of this market: $(jq -r '.market.outcomeKeys | join(", ")' "$CARD")"
case "$(jq -r '.market.state' "$CARD")" in
  closed) ;;
  open) bz_die "betting is still open or Bazaar has not closed it yet (closes $(jq -r '.timing.closeAt' "$CARD")); resolve once it is closed" ;;
  *) bz_die "this market is already $(jq -r '.market.state' "$CARD")" ;;
esac

WALLET_JSON="$(bz_json "$WALLET")"
OUTCOME_JSON="$(bz_json "$KEY")"
NOTE_JSON="$(bz_json "$NOTE")"
if [ -n "$EVIDENCE_URL" ]; then
  EVIDENCE_JSON="$(jq -cn --arg u "$EVIDENCE_URL" '[{url: $u}]')"
else
  EVIDENCE_JSON="[]"
fi

bz_say "resolve as ${KEY} (auto-refund at $(jq -r '.timing.autoRefundAt' "$CARD"))"
# contract: POST /api/bazaar/v1/markets/${MARKET_ID}/resolve proof=resolve_market market=${MARKET_ID}
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON},
  "outcome": ${OUTCOME_JSON},
  "note": ${NOTE_JSON},
  "evidence": ${EVIDENCE_JSON}
}
JSON
)
bz_post_signed resolve_market "${MARKET_ID}" "/api/bazaar/v1/markets/${MARKET_ID}/resolve" "$BODY" "resolve as \"${KEY}\""
bz_expect 200
jq '{marketId, settledOutcome, fullRefund, paid, fees: {model: .fees.model, bps: .fees.bps,
  total: .fees.total.amount, capped: .fees.capped}}' "$BZ_RESPONSE"

bz_say "result to post"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}/results
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}/results"
bz_expect 200
jq '{announcement, payouts: [.payouts[]? | {kind, amount: .amount.amount, status, txUrl}]}' "$BZ_RESPONSE"
