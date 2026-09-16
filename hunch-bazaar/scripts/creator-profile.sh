#!/usr/bin/env bash
#
# HUNCH BAZAAR: a creator's public record, the trust model (read-only).
# intent: creator_record
#
# The creator is the only resolver, so their record is what a bettor trusts:
# markets created and resolved, auto-refunds (never hidden), on-time share,
# median time to resolve, real-USDC volume, distinct bettors, badges, and their
# recent markets with pools. A 404 creator_not_found means no Bazaar record under
# that reference: say so, and never opine beyond the numbers.
#
# Usage:
#   CREATOR=@somehandle ./creator-profile.sh
#   CREATOR=0x... ./creator-profile.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

CREATOR="${CREATOR:?set CREATOR to a 0x wallet, an @handle or a creator id}"
bz_require_creator_ref "$CREATOR"
CREATOR_ENC="$(bz_uri "$CREATOR")"

bz_say "creator record: ${CREATOR}"
# contract: GET /api/bazaar/v1/creators/${CREATOR_ENC}?markets=5
bz_http GET "/api/bazaar/v1/creators/${CREATOR_ENC}?markets=5"
if [ "$BZ_STATUS" = "404" ]; then
  printf 'bazaar: no Bazaar record under %s\n' "$CREATOR" >&2
  exit 3
fi
bz_expect 200
jq '{creator, stats, badges: [.badges[]?.key],
  recentMarkets: [.markets[]? | {id, title, state, pool: .pool.total.amount, link: .links.url}]}' "$BZ_RESPONSE"
