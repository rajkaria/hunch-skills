#!/usr/bin/env bash
#
# HUNCH BAZAAR: what a market paid, read from what settlement wrote (read-only).
# intent: results
#
# settled: false while it is open or closed (with its auto-refund instant).
# Settled: the outcome, the resolution note, every payout line with its status
# (paid, pending, held for review, or unpayable) and Basescan link, totals, the
# fee take, the void reason and note, and `announcement`: a ready-to-post
# paragraph to reply with verbatim.
#
# Usage:
#   MARKET_ID=<id> ./results.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

MARKET_ID="${MARKET_ID:?set MARKET_ID to the market id or private slug}"
bz_require_market_id "$MARKET_ID"

bz_say "results: ${MARKET_ID}"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}/results
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}/results"
bz_expect 200
jq '{settled, state, outcome, void, totals, fees,
  payouts: [.payouts[]? | {kind, amount: .amount.amount, wallet, status, txUrl}],
  announcement, autoRefundAt: .timing.autoRefundAt, link: .links.url}' "$BZ_RESPONSE"
