#!/usr/bin/env bash
#
# HUNCH BAZAAR: browse and search markets; every row carries odds AND pool.
# intent: explore, search
#
# SORT: trending (the default: open markets ranked by pool, bettors and
#   recency), newest, closing_soon, resolving_soon, resolved_recently.
# Q: words that must each start a word of the question, criteria, description
#   or category ($BNKR finds bnkr).
# STATE, CATEGORY and CREATOR (0x wallet, @handle or creator id) compose.
# "No markets" is an answer only after this call returns count 0.
#
# Usage:
#   ./search.sh                                   # trending, top 5
#   SORT=closing_soon LIMIT=10 ./search.sh
#   Q='$BNKR' ./search.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

SORT="${SORT:-trending}"
LIMIT="${LIMIT:-5}"
Q="${Q:-}"
STATE="${STATE:-}"
CATEGORY="${CATEGORY:-}"
CREATOR="${CREATOR:-}"

case "$SORT" in
  trending | newest | closing_soon | resolving_soon | resolved_recently) ;;
  *) bz_die "SORT must be trending, newest, closing_soon, resolving_soon or resolved_recently" ;;
esac
bz_require_limit "$LIMIT" 100

QS="sort=${SORT}&limit=${LIMIT}"
if [ -n "$Q" ]; then
  [ "${#Q}" -le 200 ] || bz_die "Q must be 200 characters or fewer"
  QS="${QS}&q=$(bz_uri "$Q")"
fi
if [ -n "$STATE" ]; then
  case "$STATE" in
    open | closed | resolved | voided) QS="${QS}&state=${STATE}" ;;
    *) bz_die "STATE must be open, closed, resolved or voided" ;;
  esac
fi
if [ -n "$CATEGORY" ]; then
  QS="${QS}&category=$(bz_uri "$CATEGORY")"
fi
if [ -n "$CREATOR" ]; then
  bz_require_creator_ref "$CREATOR"
  QS="${QS}&creator=$(bz_uri "$CREATOR")"
fi

bz_say "markets: ${QS}"
# contract: GET /api/bazaar/v1/markets?${QS}
bz_http GET "/api/bazaar/v1/markets?${QS}"
bz_expect 200
jq '{count, sort, query, creator, markets: [.markets[] | {id, title, state, closeAt,
  odds: .impliedOddsPct, pool: .pool.total.amount, bettors: .pool.distinctBettors, link: .links.url}]}' "$BZ_RESPONSE"
