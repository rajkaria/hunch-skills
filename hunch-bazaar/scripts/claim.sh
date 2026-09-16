#!/usr/bin/env bash
#
# HUNCH BAZAAR: read creator and referral earnings, then claim them (a wallet
# proof, only when something is claimable).
# intent: claim
#
# Fee sharing is off while GET /api/bazaar/v1/fees says so, so new markets add
# nothing here; past balances still read and claim. One claim sweeps both
# ledgers and is idempotent: a second claim answers noop:true and moves
# nothing. With nothing claimable the script asks for no signature at all.
#
# Usage:
#   WALLET=0x... ./claim.sh             # read, and claim if anything is claimable
#   WALLET=0x... READ_ONLY=1 ./claim.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to your 0x wallet}"
bz_require_wallet WALLET "$WALLET"

bz_say "earnings: ${WALLET}"
# contract: GET /api/bazaar/v1/earnings?wallet=${WALLET}
bz_http GET "/api/bazaar/v1/earnings?wallet=${WALLET}"
bz_expect 200
jq '{claimable: .claimable.amount, claimed: .claimed.amount, referralClaimable: .referral.claimable.amount}' "$BZ_RESPONSE"
if [ -n "${READ_ONLY:-}" ]; then
  exit 0
fi
if ! jq -e '((.claimable.micros | tonumber) + (.referral.claimable.micros | tonumber)) > 0' "$BZ_RESPONSE" >/dev/null &&
  [ "${FORCE:-}" != "1" ]; then
  bz_say "nothing to claim; no signature requested"
  exit 0
fi

WALLET_JSON="$(bz_json "$WALLET")"

bz_say "claim"
# contract: POST /api/bazaar/v1/earnings proof=claim_earnings market=-
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON}
}
JSON
)
bz_post_signed claim_earnings - "/api/bazaar/v1/earnings" "$BODY" "claim earnings"
bz_expect 200
jq '{noop, claimed: .claimed.amount, referralClaimed: .referralClaimed.amount, marketIds}' "$BZ_RESPONSE"
