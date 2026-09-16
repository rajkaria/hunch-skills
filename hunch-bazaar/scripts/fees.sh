#!/usr/bin/env bash
#
# HUNCH BAZAAR: the fee schedule, limits and guarantee from live config (help).
# intent: help
#
# Quote `summary`, `guarantee` and `createLimits` as returned. Never state a fee,
# a limit or a window from memory.
#
# Usage:
#   ./fees.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

bz_say "fee schedule"
# contract: GET /api/bazaar/v1/fees
bz_http GET "/api/bazaar/v1/fees"
bz_expect 200
jq '{summary, minBet: .minBet.amount, caps: .caps.note, noFeeOn, guarantee: .guarantee.rule,
  createLimits: .createLimits.summary, referralShareOn: .referralShare.enabled,
  creatorShareOn: .creatorShare.enabled}' "$BZ_RESPONSE"
