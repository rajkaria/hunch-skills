#!/usr/bin/env bash
#
# HUNCH BAZAAR: the public creator leaderboards (read-only).
# intent: boards
#
# BOARD: weekly (default), season, alltime, category, rising. Rows carry the
# creator id and handle: feed either straight into creator-profile.sh or
# creator-markets.sh.
#
# Usage:
#   ./boards.sh
#   BOARD=alltime LIMIT=25 ./boards.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

BOARD="${BOARD:-weekly}"
LIMIT="${LIMIT:-10}"
case "$BOARD" in
  weekly | season | alltime | category | rising) ;;
  *) bz_die "BOARD must be weekly, season, alltime, category or rising" ;;
esac
bz_require_limit "$LIMIT" 50

bz_say "leaderboard: ${BOARD} (top ${LIMIT})"
# contract: GET /api/bazaar/boards?board=${BOARD}&limit=${LIMIT}
bz_http GET "/api/bazaar/boards?board=${BOARD}&limit=${LIMIT}"
bz_expect 200
jq '{board, weekKey, unit, rows: [.rows[]? | {rank, creatorId, handle, tier, score}]}' "$BZ_RESPONSE"
