#!/usr/bin/env bash
#
# HUNCH BAZAAR: bet on a Bazaar market. The stake is paid over x402 before the
# bet exists.
# intent: bet
#
# 1. Read the card (existence, outcome keys, who settles it and their record)
#    and quote the stake (payout, multiple, fee, pool after). Stop there unless
#    CONFIRM=1: the user confirms the quote, the disclosure and the amount first.
# 2. POST the bet without payment → 402 for exactly the stake → the challenge is
#    pin-checked against x402-registry.json → ONE EIP-3009 authorization is built
#    from the pinned values and signed through Bankr → the SAME body is resent
#    with X-PAYMENT.
# 3. 201 is a new bet with its Base tx. 200 with replayed:true is a bet that
#    already stood; it was not charged again.
#
# AMOUNT: at least 0.50 USDC, no Hunch maximum. IDEM: one per intended bet, reused
# verbatim on every retry (on X: x-<the mention post id>); a rerun resends the
# payment already signed for it. A wallet's first bet needs register.sh once
# (403 agent_not_registered). REF_CODE: the referralCode a shared link carried.
#
# Usage:
#   WALLET=0x... MARKET_ID=<id> OUTCOME=yes AMOUNT=5.00 IDEM=x-1830000000000000009 ./bet.sh
#   ... CONFIRM=1 ./bet.sh
#
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

WALLET="${WALLET:?set WALLET to the paying 0x wallet}"
MARKET_ID="${MARKET_ID:?set MARKET_ID to the market id}"
OUTCOME="${OUTCOME:?set OUTCOME to one of the market outcome keys}"
AMOUNT="${AMOUNT:?set AMOUNT to decimal USDC, for example 5.00}"
IDEM="${IDEM:-bet-$(date -u +%s)-$(bz_random_hex32 | cut -c1-12)}"
REF_CODE="${REF_CODE:-}"
bz_require_wallet WALLET "$WALLET"
bz_require_market_id "$MARKET_ID"
bz_require_outcome "$OUTCOME"
bz_require_amount "$AMOUNT"
if [ -n "$REF_CODE" ]; then
  printf '%s' "$REF_CODE" | grep -Eq '^[A-Za-z0-9]{1,64}$' || bz_die "REF_CODE must be 1-64 letters or digits"
fi

bz_say "read the market"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}"
bz_expect 200
CARD="${BZ_TMP}/card.json"
cp "$BZ_RESPONSE" "$CARD"
MARKET_ID="$(jq -r '.market.id' "$CARD")"
KEY="$(jq -r --arg o "$OUTCOME" '[.market.outcomeKeys[] | select(ascii_downcase == ($o | ascii_downcase))][0] // empty' "$CARD")"
[ -n "$KEY" ] || bz_die "\"${OUTCOME}\" is not an outcome of this market: $(jq -r '.market.outcomeKeys | join(", ")' "$CARD")"
OUTCOME_ENC="$(bz_uri "$KEY")"

bz_say "quote ${AMOUNT} USDC on ${KEY}"
# contract: GET /api/bazaar/v1/markets/${MARKET_ID}/quote?outcome=${OUTCOME_ENC}&amount=${AMOUNT}
bz_http GET "/api/bazaar/v1/markets/${MARKET_ID}/quote?outcome=${OUTCOME_ENC}&amount=${AMOUNT}"
bz_expect 200
jq --slurpfile card "$CARD" '{question: .market.title, stake: .quote.stake.amount,
  payoutIfWin: .quote.payoutIfWin.amount, multiple: .quote.multiple, fee: .quote.fee.total.amount,
  refundedSingleBettor: .quote.refundedSingleBettor, poolAfter: .pool.after.amount,
  settledBy: ($card[0].creator.handle // $card[0].creator.wallet), record: $card[0].creator.recordLine,
  autoRefundAt: $card[0].timing.autoRefundAt, bettable, note,
  disclosure: "Bazaar markets are resolved by the person who opened them. Unresolved 48h past the deadline, every bettor is refunded in full. Betting risks the whole stake. Not financial advice."}' "$BZ_RESPONSE"
jq -e '.bettable.ok == true' "$BZ_RESPONSE" >/dev/null ||
  bz_die "this bet cannot be placed now: $(jq -r '.bettable.message // .bettable.code' "$BZ_RESPONSE")"
if [ "${CONFIRM:-}" != "1" ]; then
  bz_say "nothing was paid: confirm the quote above, then re-run with CONFIRM=1 IDEM=${IDEM}"
  exit 0
fi

WALLET_JSON="$(bz_json "$WALLET")"
OUTCOME_JSON="$(bz_json "$KEY")"
AMOUNT_JSON="$(bz_json "$AMOUNT")"
IDEM_JSON="$(bz_json "$IDEM")"

bz_say "bet ${AMOUNT} USDC on ${KEY} (IDEM=${IDEM}; reuse it on any retry)"
# contract: POST /api/bazaar/v1/markets/${MARKET_ID}/bets x402=stake amount=${AMOUNT}
BODY=$(cat <<JSON
{
  "walletAddress": ${WALLET_JSON},
  "outcomeKey": ${OUTCOME_JSON},
  "amount": ${AMOUNT_JSON},
  "idempotencyKey": ${IDEM_JSON}
}
JSON
)
if [ -n "$REF_CODE" ]; then
  BODY="$(printf '%s' "$BODY" | jq -c --arg r "$REF_CODE" '. + {refCode: $r}')"
fi
bz_post_paid "/api/bazaar/v1/markets/${MARKET_ID}/bets" "$BODY" "$MARKET_ID" "$AMOUNT"
bz_expect 200 201
jq '{replayed, bet: {id: .bet.id, outcomeKey: .bet.outcomeKey, stake: .bet.stake.amount,
  intoPool: .bet.intoPool.amount}, payment,
  txUrl: (if ((.payment.txRef // "") | test("^0x[0-9a-fA-F]{64}$")) then "https://basescan.org/tx/" + .payment.txRef else null end),
  refund: (.refund // null)}' "$BZ_RESPONSE"
