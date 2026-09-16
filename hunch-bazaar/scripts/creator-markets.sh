#!/usr/bin/env bash
#
# HUNCH BAZAAR: every public market a creator made, newest first (read-only).
# intent: creator_markets, my_markets
#
# CREATOR is a 0x wallet, an X handle linked on the web (@ optional), or a raw
# creator id. A creator who only ever used @bankrbot is found by wallet: take it
# from any of their market cards (settledBy.wallet). With no CREATOR the
# script lists WALLET's own markets ("my markets"). STATE slices the list:
# open (still bettable), closed, resolved, voided.
#
# Usage:
#   CREATOR=@somehandle ./creator-markets.sh
#   WALLET=0x... ./creator-markets.sh              # my markets
#   CREATOR=0x... STATE=open ./creator-markets.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

CREATOR="${CREATOR:-${WALLET:-}}"
[ -n "$CREATOR" ] || bz_die "set CREATOR (wallet, @handle or id), or WALLET for your own markets"
bz_require_creator_ref "$CREATOR"
CREATOR_ENC="$(bz_uri "$CREATOR")"
LIMIT="${LIMIT:-50}"
bz_require_limit "$LIMIT" 100
STATE_QS=""
if [ -n "${STATE:-}" ]; then
  case "$STATE" in
    open | closed | resolved | voided) STATE_QS="&state=${STATE}" ;;
    *) bz_die "STATE must be open, closed, resolved or voided" ;;
  esac
fi

bz_say "markets by ${CREATOR}"
# contract: GET /api/bazaar/v1/markets?creator=${CREATOR_ENC}&sort=newest&limit=${LIMIT}${STATE_QS}
bz_http GET "/api/bazaar/v1/markets?creator=${CREATOR_ENC}&sort=newest&limit=${LIMIT}${STATE_QS}"
bz_expect 200
jq '{count, creator, markets: [.markets[] | {id, title, state, closeAt, resolvedOutcome,
  odds: .impliedOddsPct, pool: .pool.total.amount, bettors: .pool.distinctBettors, link: .links.url}]}' "$BZ_RESPONSE"
