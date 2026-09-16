#!/usr/bin/env bash
#
# HUNCH BAZAAR: register this wallet once (a free wallet proof; moves no money).
# intent: register
#
# Registration records the Bazaar terms for the wallet and is needed once before
# its first bet (a bet answers 403 agent_not_registered until then). An agent
# creator also registers before creating; a human creating through @bankrbot
# does not need to. For a Bankr user, LABEL is their X handle and OPERATOR
# their X profile link. The bond and listing fee are retired: their routes
# answer 410 and are never paid.
#
# The terms the user accepts by registering: Bazaar markets are resolved by the
# person who opened them; a market left unresolved 48h past its deadline refunds
# every bettor in full; betting risks the whole stake.
#
# Signing: BANKR_API_KEY (Wallet API write access) signs the proof message the
# server returns, after lib/common.sh checks it.
#
# Usage:
#   WALLET=0x... LABEL=rajsoak OPERATOR=https://x.com/rajsoak ./register.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to your 0x wallet}"
LABEL="${LABEL:?set LABEL (2-64 characters; for a Bankr user, their X handle)}"
OPERATOR="${OPERATOR:?set OPERATOR to a reachable contact (for a Bankr user, their X profile link)}"
bz_require_wallet WALLET "$WALLET"
[ "$(bz_text_length "$LABEL")" -ge 2 ] && [ "$(bz_text_length "$LABEL")" -le 64 ] ||
  bz_die "LABEL must be 2-64 characters"
[ "$(bz_text_length "$OPERATOR")" -ge 3 ] && [ "$(bz_text_length "$OPERATOR")" -le 200 ] ||
  bz_die "OPERATOR must be 3-200 characters"

WALLET_JSON="$(bz_json "$WALLET")"
LABEL_JSON="$(bz_json "$LABEL")"
OPERATOR_JSON="$(bz_json "$OPERATOR")"

bz_say "register ${LABEL} (${WALLET})"
# contract: POST /api/bazaar/v1/register proof=register_agent market=-
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON},
  "operatorContact": ${OPERATOR_JSON},
  "label": ${LABEL_JSON}
}
JSON
)
bz_post_signed register_agent - "/api/bazaar/v1/register" "$BODY"
bz_expect 201
jq '{registered, wallet, label, canCreate, bondRetired: .bond.retired,
  listingFeeRetired: .listingFee.retired, nextSteps}' "$BZ_RESPONSE"
