# The market card, as the skill quotes it: odds AND pool per outcome, who
# settles it and their record, their own position, timing and links.
# Input: GET /api/bazaar/v1/markets/{id} or /markets/lookup?ref=.
{
  id: .market.id,
  question: .market.title,
  state: .market.state,
  outcomes: [
    (.market.outcomeKeys // [])[] as $k
    | {
        key: $k,
        oddsPct: (if .impliedOddsPct then .impliedOddsPct[$k] else null end),
        pool: (.pool.byOutcome[$k].amount // "0.00")
      }
  ],
  pool: .pool.total.amount,
  bettors: .pool.distinctBettors,
  bets: .pool.betCount,
  closeAt: .timing.closeAt,
  resolveDeadlineAt: .timing.resolveDeadlineAt,
  autoRefundAt: .timing.autoRefundAt,
  settledBy: {
    handle: .creator.handle,
    wallet: .creator.wallet,
    agentLabel: .creator.agentLabel,
    record: .creator.recordLine
  },
  creatorPosition: .market.creatorPosition,
  feeTerms: .market.feeTerms,
  criteria: .market.criteria,
  sources: [(.market.sources // [])[]?.url],
  voidNote: .market.voidNote,
  link: .links.url,
  share: .share.text,
  referralCode: (.referralCode // null),
  yourBets: (.positions // null)
}
