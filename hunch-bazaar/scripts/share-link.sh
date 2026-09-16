#!/usr/bin/env bash
#
# HUNCH BAZAAR: mint this wallet's share link for a market (a wallet proof).
# intent: share
#
# The link carries this wallet's ref code: bets that arrive through it are
# attributed to the sharer. Whether attribution also earns a fee share is live
# config (GET /api/bazaar/v1/fees, referralShare); never promise earnings.
# Deterministic: the same wallet and market always get the same code. A private
# market's link can only be minted by its creator. Also prints the card's
# ready-to-post share line.
#
# Usage:
#   WALLET=0x... MARKET_ID=<id> ./share-link.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to your 0x wallet}"
MARKET_ID="${MARKET_ID:?set MARKET_ID to the market id}"
bz_require_wallet WALLET "$WALLET"
bz_require_market_id "$MARKET_ID"

bz_say "read the market"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}"
bz_expect 200
SHARE_TEXT="$(jq -r '.share.text' "$BZ_RESPONSE")"
MARKET_ID="$(jq -r '.market.id' "$BZ_RESPONSE")"

WALLET_JSON="$(bz_json "$WALLET")"
MARKET_ID_JSON="$(bz_json "$MARKET_ID")"

bz_say "mint share link: ${MARKET_ID}"
# contract: POST /api/bazaar/v1/ref/register proof=register_ref_link market=${MARKET_ID}
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON},
  "marketId": ${MARKET_ID_JSON}
}
JSON
)
bz_post_signed register_ref_link "${MARKET_ID}" "/api/bazaar/v1/ref/register" "$BODY" "mint a share link"
bz_expect 201
jq --arg text "$SHARE_TEXT" '{refCode, shareUrl, quickUrl, shareText: $text}' "$BZ_RESPONSE"
