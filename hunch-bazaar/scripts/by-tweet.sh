#!/usr/bin/env bash
#
# HUNCH BAZAAR: find the market an X post created (the thread map; read-only).
# intent: resolve, odds
#
# A reply in a market's thread ("resolve YES", "bet $2 NO on this") names no
# link. TWEET_IDS lists the thread's post ids nearest first: the post being
# replied to, then its parents up to the conversation root. The first public
# market found wins; at most 10 ids are tried. Private markets are never found
# this way. Exit 3 means none of those posts created a public market: ask the
# user for the market link.
#
# Usage:
#   TWEET_IDS="1830000000000000003 1830000000000000002 1830000000000000001" ./by-tweet.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

TWEET_IDS="${TWEET_IDS:?set TWEET_IDS to the thread post ids, nearest first}"

set -f
tried=0
for TWEET_ID in $TWEET_IDS; do
  tried=$((tried + 1))
  [ "$tried" -le 10 ] || break
  bz_require_tweet_id "$TWEET_ID" TWEET_IDS
  bz_say "market from post ${TWEET_ID}"
  # contract: GET /api/bazaar/v1/markets/by-tweet/${TWEET_ID}
  bz_http GET "/api/bazaar/v1/markets/by-tweet/${TWEET_ID}"
  if [ "$BZ_STATUS" = "200" ]; then
    jq '{sourceTweetId, market: {id: .market.id, title: .market.title, state: .market.state,
      outcomes: .market.outcomeKeys, closeAt: .market.closeAt, resolveDeadlineAt: .market.resolveDeadlineAt},
      settledBy: {wallet: .creator.wallet, handle: .creator.handle, verified: .creator.verified},
      pool: {total: .pool.total.amount, bettors: .pool.distinctBettors}}' "$BZ_RESPONSE"
    exit 0
  fi
  [ "$BZ_STATUS" = "404" ] || bz_expect 200 404
done
set +f

printf 'bazaar: none of those posts created a public Bazaar market; ask for the market link\n' >&2
exit 3
