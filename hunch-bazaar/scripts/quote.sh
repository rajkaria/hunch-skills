#!/usr/bin/env bash
#
# HUNCH BAZAAR: quote a bet before placing it (read-only).
# intent: quote
#
# Every number comes from the settlement engine: the stake into the pool, the
# payout and multiple if that outcome won against the pool as it stands, the
# fee on this market's own terms (capped at the losing side) and your share of
# it, whether you would be the only bettor (a full refund, not a win), the pool
# and odds after the bet, and whether it can be placed now. Quote them; never
# compute a payout. Every later bet moves them.
#
# Usage:
#   MARKET_ID=<id> OUTCOME=yes AMOUNT=5.00 ./quote.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

MARKET_ID="${MARKET_ID:?set MARKET_ID to the market id}"
OUTCOME="${OUTCOME:?set OUTCOME to one of the market outcome keys}"
AMOUNT="${AMOUNT:?set AMOUNT to decimal USDC, for example 5.00}"
bz_require_market_id "$MARKET_ID"
bz_require_outcome "$OUTCOME"
bz_require_amount "$AMOUNT"
OUTCOME_ENC="$(bz_uri "$OUTCOME")"

bz_say "quote ${AMOUNT} USDC on ${OUTCOME}: ${MARKET_ID}"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}/quote?outcome=${OUTCOME_ENC}&amount=${AMOUNT}
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}/quote?outcome=${OUTCOME_ENC}&amount=${AMOUNT}"
bz_expect 200
jq '{market: {id: .market.id, title: .market.title, state: .market.state, feeTerms: .market.feeTerms},
  stake: .quote.stake.amount, intoPool: .quote.intoPool.amount,
  payoutIfWin: .quote.payoutIfWin.amount, multiple: .quote.multiple,
  fee: {model: .quote.fee.model, bps: .quote.fee.bps, total: .quote.fee.total.amount,
    yourShareIfWin: .quote.fee.yourShareIfWin.amount, capped: .quote.fee.capped},
  refundedSingleBettor: .quote.refundedSingleBettor,
  poolAfter: .pool.after.amount, oddsAfterPct: .pool.impliedOddsPctAfter,
  bettable, note}' "$BZ_RESPONSE"
