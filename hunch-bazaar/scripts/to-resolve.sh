#!/usr/bin/env bash
#
# HUNCH BAZAAR: the markets a creator still owes an answer on (read-only).
# intent: to_resolve
#
# Public markets past close and unresolved, soonest resolve deadline first, each
# with its auto-refund instant and phase: due (resolve now), overdue (past the
# deadline, still resolvable), awaiting_close (betting ended; Bazaar closes it
# within minutes), auto_refund_due (too late: everyone is refunded).
# canResolveNow is true for due and overdue.
#
# Usage:
#   WALLET=0x... ./to-resolve.sh           # my markets to resolve
#   CREATOR=@somehandle ./to-resolve.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

CREATOR="${CREATOR:-${WALLET:-}}"
[ -n "$CREATOR" ] || bz_die "set WALLET (your markets) or CREATOR"
bz_require_creator_ref "$CREATOR"
CREATOR_ENC="$(bz_uri "$CREATOR")"

bz_say "to resolve: ${CREATOR}"
# contract: GET /api/bazaar/v1/creators/${CREATOR_ENC}/to-resolve
bz_http GET "/api/bazaar/v1/creators/${CREATOR_ENC}/to-resolve"
bz_expect 200
jq '{count, guaranteeHours, markets: [.markets[] | {id, title, state, pool: .pool.total.amount,
  phase: .resolveBy.phase, canResolveNow: .resolveBy.canResolveNow,
  resolveDeadlineAt: .resolveBy.resolveDeadlineAt, autoRefundAt: .resolveBy.autoRefundAt,
  link: .links.url}]}' "$BZ_RESPONSE"
