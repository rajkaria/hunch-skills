#!/usr/bin/env bash
#
# HUNCH BAZAAR: this wallet's standing on the rail (read-only, no signature).
# intent: whoami
#
# Registered or not (registering records the Bazaar terms and is needed once
# before a first bet), whether it can create as an agent, and whether the bond
# and listing fee are retired (they are: both answer 410 and are never paid).
# A human creating through @bankrbot needs no registration to create.
#
# Usage:
#   WALLET=0x... ./status.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to the 0x wallet}"
bz_require_wallet WALLET "$WALLET"

bz_say "standing: ${WALLET}"
# contract: GET /api/bazaar/v1/register?wallet=${WALLET}
bz_http GET "/api/bazaar/v1/register?wallet=${WALLET}"
bz_expect 200
jq '{registered, wallet, label, canCreate, openMarketCount,
  bondRetired: (.bond.retired // null), listingFeeRetired: (.listingFee.retired // null)}' "$BZ_RESPONSE"
