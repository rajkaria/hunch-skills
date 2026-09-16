#!/usr/bin/env bash
#
# HUNCH BAZAAR: preview a market before creating it (writes nothing, no signature).
# intent: make
#
# The server normalizes the draft exactly as a create would store it and lists
# every issue with the refusal code a create would return, plus the fee terms,
# who resolves it, the immutability notice, the auto-refund guarantee, similar
# open markets and, when clean, the confirm body. Show the preview; publish only
# after the user confirms (create-market.sh with CONFIRM=1). Draft text a model
# wrote is advisory: what gets published is the server's normalized preview.
#
# Usage:
#   WALLET=0x... X_HANDLE=rajkaria \
#     TITLE='Will ETH close above $4,000 on Sep 19, 2026?' \
#     CRITERIA='Resolves YES if the CoinGecko ETH/USD daily close for Sep 19, 2026 (UTC) is above 4000.' \
#     SOURCE_URL=https://www.coingecko.com/en/coins/ethereum CLOSE_IN=3d ./draft.sh
#   Optional: CLOSE_AT and RESOLVE_BY (ISO-8601 UTC, used instead of CLOSE_IN),
#   OUTCOMES="a,b,c" (N-way), CATEGORY, SOURCE_TWEET_ID, VISIBILITY=private,
#   CREATED_VIA=agent (the default is bankr when X_HANDLE is set).
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
jq -f "${BZ_LIB_DIR}/preview.jq" "$BZ_RESPONSE"
