#!/usr/bin/env bash
#
# HUNCH BAZAAR: this wallet's Bazaar bets, open and settled (read-only).
# intent: positions
#
# Grouped per market with every bet and every payout line. A payout's state is
# paid, pending, held (a review holds it) or unpayable, with its tx hash once
# sent. Only this wallet's rail bets are visible here.
#
# Usage:
#   WALLET=0x... ./positions.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to the 0x wallet}"
bz_require_wallet WALLET "$WALLET"

bz_say "positions: ${WALLET}"
# contract: GET /api/bazaar/v1/positions?wallet=${WALLET}
bz_http GET "/api/bazaar/v1/positions?wallet=${WALLET}"
bz_expect 200
jq '{count,
  open: [.open[] | {marketId, title, state, stake: .stake.amount,
    bets: [.bets[] | {outcomeKey, stake: .stake.amount}]}],
  settled: [.settled[] | {marketId, title, state, resolvedOutcome, stake: .stake.amount,
    payouts: [.payouts[] | {kind, amount: .amount.amount, state, txHash}]}]}' "$BZ_RESPONSE"
