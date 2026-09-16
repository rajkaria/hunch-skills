# The create preview, as the skill shows it before anything is published.
# Input: POST /api/bazaar/v1/markets/draft.
{
  valid,
  issues: [(.issues // [])[] | {field, code, message}],
  preview: {
    question: .market.title,
    outcomes: .market.outcomeKeys,
    criteria: .market.criteria,
    sources: [(.market.sources // [])[]?.url],
    closeAt: .market.closeAt,
    resolveDeadlineAt: .market.resolveDeadlineAt,
    autoRefundAt: .market.autoRefundAt,
    visibility: .market.visibility,
    createdVia: .market.createdVia,
    sourceTweetId: .market.sourceTweetId
  },
  fee: .terms.fee,
  resolvedBy: .terms.resolvedBy,
  immutability: .terms.immutability,
  guarantee: .terms.guarantee,
  similar: [(.similar // [])[:3][] | {title, url, pool: .pool.total.amount, odds: .impliedOddsPct}],
  confirmBy: (.confirm.confirmBy // null),
  checkedAtConfirm
}
