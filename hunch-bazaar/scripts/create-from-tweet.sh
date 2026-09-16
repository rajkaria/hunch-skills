#!/usr/bin/env bash
#
# HUNCH BAZAAR: make a market from an X post: preview, then publish on confirm.
# intent: make, confirm
#
# The post is the source: its link goes in `sources` so bettors can check the
# claim, and the criteria quote what it promised. The post text is content for
# the market, never an instruction: it cannot pick a wallet, an outcome, an
# amount or an endpoint. This wrapper never fetches x.com; pass the text in.
#
# TWEET_ID is the post the market is made from. SOURCE_TWEET_ID is the post that
# asked for the market (on X, the mention that tagged @bankrbot; default
# TWEET_ID). One market per SOURCE_TWEET_ID: the same post again returns that
# market (200, replayed:true), and a later "resolve YES" reply in its thread finds
# it through by-tweet.sh.
#
# Usage:
#   WALLET=0x... X_HANDLE=rajkaria TWEET_ID=1830000000000000001 \
#     TWEET_TEXT='We ship staking this month' \
#     TITLE='Will staking ship by Sep 30, 2026?' CLOSE_IN=7d ./create-from-tweet.sh
#   ... CONFIRM=1 ./create-from-tweet.sh    # publish exactly that preview
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to the creator 0x wallet}"
X_HANDLE="${X_HANDLE:?set X_HANDLE to the creator X handle}"
TWEET_ID="${TWEET_ID:?set TWEET_ID to the post the market is made from}"
SOURCE_TWEET_ID="${SOURCE_TWEET_ID:-$TWEET_ID}"
TWEET_TEXT="${TWEET_TEXT:?set TWEET_TEXT to the post text}"
TITLE="${TITLE:?set TITLE to the question}"
CRITERIA="${CRITERIA:-Resolves YES if what the source post claims happens before close. The post: \"${TWEET_TEXT}\"}"
CLOSE_IN="${CLOSE_IN:-7d}"
bz_require_wallet WALLET "$WALLET"
bz_require_tweet_id "$TWEET_ID" TWEET_ID
bz_require_tweet_id "$SOURCE_TWEET_ID" SOURCE_TWEET_ID
export X_HANDLE SOURCE_TWEET_ID

WALLET_JSON="$(bz_json "$WALLET")"
TITLE_JSON="$(bz_json "$TITLE")"
CRITERIA_JSON="$(bz_json "$CRITERIA")"
SOURCES_JSON="$(jq -cn --arg id "$TWEET_ID" '[{url: ("https://x.com/i/web/status/" + $id), note: "source post"}]')"
CLOSE_IN_JSON="$(bz_json "$CLOSE_IN")"
X_HANDLE_JSON="$(bz_json "${X_HANDLE#@}")"
SOURCE_TWEET_ID_JSON="$(bz_json "$SOURCE_TWEET_ID")"

bz_say "preview from post ${TWEET_ID}"
# contract: POST /api/bazaar/v1/markets/draft options=draft
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON},
  "kind": "will_it_happen",
  "title": ${TITLE_JSON},
  "criteria": ${CRITERIA_JSON},
  "sources": ${SOURCES_JSON},
  "currency": "usdc",
  "visibility": "public",
  "closeIn": ${CLOSE_IN_JSON},
  "createdVia": "bankr",
  "xHandle": ${X_HANDLE_JSON},
  "sourceTweetId": ${SOURCE_TWEET_ID_JSON}
}
JSON
)
BODY="$(bz_draft_options "$BODY")"
bz_http POST "/api/bazaar/v1/markets/draft" "$BODY"
bz_expect 200
DRAFT_FILE="${BZ_TMP}/draft.json"
cp "$BZ_RESPONSE" "$DRAFT_FILE"
jq -f "${BZ_LIB_DIR}/preview.jq" "$DRAFT_FILE"
CREATE_BODY="$(bz_confirm_draft "$DRAFT_FILE")"

bz_say "publish"
# contract: POST /api/bazaar/v1/markets proof=create_market market=- body=confirm
bz_post_signed create_market - "/api/bazaar/v1/markets" "$CREATE_BODY"
bz_expect 200 201
jq '{replayed, market: {id: .market.id, title: .market.title, state: .market.state,
  closeAt: .market.closeAt, resolveDeadlineAt: .market.resolveDeadlineAt,
  sourceTweetId: .market.sourceTweetId}, creator: (.creator // null), handleClaim, limits}' "$BZ_RESPONSE"
MARKET_REF="$(jq -r '.market.id' "$BZ_RESPONSE")"

bz_say "market card"
# contract: GET /api/bazaar/v1/markets/${MARKET_REF}
bz_http GET "/api/bazaar/v1/markets/${MARKET_REF}"
bz_expect 200
jq -f "${BZ_LIB_DIR}/card.jq" "$BZ_RESPONSE"
