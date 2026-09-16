#!/usr/bin/env bash
#
# HUNCH BAZAAR: make a market from a phrase: preview, then publish on confirm.
# intent: make, confirm
#
# 1. Draft (writes nothing): print the server's normalized preview, issues,
#    fee terms, immutability notice, guarantee and similar markets.
# 2. Stop there unless CONFIRM=1. Nothing is created until the user confirms
#    exactly that preview.
# 3. Publish the preview's confirm body with a wallet proof (the server returns
#    the message; lib/common.sh checks it before Bankr signs it).
#    201 = created. 200 with replayed:true = this post already made that market.
# 4. Read the new market card back for its link.
#
# Once published nothing about the market can change. The creator is its only
# resolver; left unresolved 48h past its deadline, every bettor is refunded.
# Creation limits apply (a named 422 carries the exact sentence to quote).
#
# Usage:
#   WALLET=0x... X_HANDLE=rajkaria TITLE='Will ETH close above $4,000 on Sep 19, 2026?' \
#     CRITERIA='Resolves YES if the CoinGecko ETH/USD daily close for Sep 19, 2026 (UTC) is above 4000.' \
#     SOURCE_URL=https://www.coingecko.com/en/coins/ethereum CLOSE_IN=3d ./create-market.sh
#   ... CONFIRM=1 ./create-market.sh        # publish exactly that preview
#   On X, SOURCE_TWEET_ID is the post that asked for the market, and a confirm
#   re-drafts with CLOSE_AT/RESOLVE_BY set to the times the preview showed.
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to the creator 0x wallet}"
TITLE="${TITLE:?set TITLE to the question}"
CRITERIA="${CRITERIA:?set CRITERIA to exactly what resolves it}"
SOURCE_URL="${SOURCE_URL:?set SOURCE_URL to the https link bettors can check}"
CLOSE_IN="${CLOSE_IN:-7d}"
VISIBILITY="${VISIBILITY:-public}"
X_HANDLE="${X_HANDLE:-}"
if [ -z "${CREATED_VIA:-}" ]; then
  if [ -n "$X_HANDLE" ]; then CREATED_VIA=bankr; else CREATED_VIA=agent; fi
fi
bz_require_wallet WALLET "$WALLET"
bz_require_https_url SOURCE_URL "$SOURCE_URL"
case "$VISIBILITY" in public | private) ;; *) bz_die "VISIBILITY must be public or private" ;; esac
case "$CREATED_VIA" in bankr | agent) ;; *) bz_die "CREATED_VIA must be bankr or agent" ;; esac

WALLET_JSON="$(bz_json "$WALLET")"
TITLE_JSON="$(bz_json "$TITLE")"
CRITERIA_JSON="$(bz_json "$CRITERIA")"
SOURCES_JSON="$(jq -cn --arg u "$SOURCE_URL" '[{url: $u}]')"
VISIBILITY_JSON="$(bz_json "$VISIBILITY")"
CLOSE_IN_JSON="$(bz_json "$CLOSE_IN")"
CREATED_VIA_JSON="$(bz_json "$CREATED_VIA")"

bz_say "preview: ${TITLE}"
# contract: POST /api/bazaar/v1/markets/draft options=draft
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON},
  "kind": "will_it_happen",
  "title": ${TITLE_JSON},
  "criteria": ${CRITERIA_JSON},
  "sources": ${SOURCES_JSON},
  "currency": "usdc",
  "visibility": ${VISIBILITY_JSON},
  "closeIn": ${CLOSE_IN_JSON},
  "createdVia": ${CREATED_VIA_JSON}
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
  visibility: .market.visibility, closeAt: .market.closeAt, resolveDeadlineAt: .market.resolveDeadlineAt,
  sourceTweetId: .market.sourceTweetId}, creator: (.creator // null), limits}' "$BZ_RESPONSE"
MARKET_REF="$(jq -r '.market.privateSlug // .market.id' "$BZ_RESPONSE")"

bz_say "market card"
# contract: GET /api/bazaar/v1/markets/${MARKET_REF}
bz_http GET "/api/bazaar/v1/markets/${MARKET_REF}"
bz_expect 200
jq -f "${BZ_LIB_DIR}/card.jq" "$BZ_RESPONSE"
