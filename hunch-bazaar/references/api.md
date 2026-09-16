# The Bazaar API fields this skill reads

Every call targets `https://bazaar.playhunch.xyz`. Reads are keyless `GET`s.
Money is `{ "amount": "5.00", "micros": "5000000" }`: quote `amount`, compare
`micros`, never floats. Response `version` is `bazaar-agent-api-v1`.

## Market card: `GET /api/bazaar/v1/markets/lookup?ref=` and `GET /api/bazaar/v1/markets/{id}`

`ref` is a pasted Bazaar link (`bazaar.playhunch.xyz/markets/<x>`, `/quick/<x>`,
`/embed/<x>`, or `playhunch.xyz/bazaar/...`, with or without `https://` and
`?ref=`), a market id, or a private slug. `{id}` is an id or a slug.

- `market`: `id`, `title`, `criteria`, `description`, `sources[]`, `outcomeKeys[]`,
  `state` (`open`, `closed`, `resolved`, `voided`), `visibility`, `closeAt`,
  `resolveDeadlineAt`, `feeTerms { model, bps }`, `creatorPosition { byOutcome, total }`
  or null, `resolvedOutcome`, `voidReason`, `voidNote`, `createdVia`, `sourceTweetId`,
  `agentLabel`.
- `pool`: `total`, `byOutcome`, `betCount`, `distinctBettors`.
- `impliedOddsPct`: odds per outcome from the money in the pool, or null when there
  are no bets yet.
- `timing`: `closeAt`, `resolveDeadlineAt`, `autoRefundAt`, `guaranteeHours`.
- `creator`: `creatorId`, `wallet`, `handle`, `agentLabel`, `profileUrl`,
  `record { marketsCreated, marketsResolved, autoRefunded, onTimePct, medianResolveSeconds }`,
  `recordLine`.
- `links`: `url`, `quickUrl`, `embedUrl`, `ogImageUrl`. `share`: `text` (a
  ready-to-post line), `url`, `ogImageUrl`.
- lookup adds `resolvedVia` and `referralCode`; `?wallet=` adds `positions`.
- Misses: `400 invalid_market_ref` or `unsupported_market_url` (lookup),
  `404 market_not_found`.

## The market a post created: `GET /api/bazaar/v1/markets/by-tweet/{tweetId}`

- `sourceTweetId`, `market` (as above, with `creatorPosition`),
  `creator { creatorId, wallet, handle, verified, via }`, `pool`.
- Public markets only. `404 market_not_found` for a post with no public market,
  `400 invalid_tweet_id` for a malformed id.

## Browse and search: `GET /api/bazaar/v1/markets`

- Query: `sort` (`trending`, `newest`, `closing_soon`, `resolving_soon`,
  `resolved_recently`), `q` (words that each start a word of the title, criteria,
  description or category), `state`, `creator` (a wallet, `@handle` or creator id),
  `kind`, `category`, `currency`, `limit` (1 to 100).
- `count`, `sort`, `query { q, tokens }`, `creator { creatorId, wallet, handle }`, and
  `markets[]`: the market fields plus `agentLabel`, `pool`, `impliedOddsPct`, `links`.
- Refusals: `400 invalid_sort`, `invalid_state`, `invalid_state_for_sort`,
  `invalid_query`.

## Quote: `GET /api/bazaar/v1/markets/{id}/quote?outcome=&amount=`

- `market { id, title, state, currency, outcomeKeys, closeAt, feeTerms }`.
- `quote { outcomeKey, stake, intoPool, payoutIfWin, multiple, fee { model, bps, total, yourShareIfWin, capped }, refundedSingleBettor }`.
- `pool { before, after, impliedOddsPctAfter }`.
- `bettable`: `{ ok: true }` or `{ ok: false, code, message }`.
- `asOf`, `note`.
- Refusals: `400 invalid_amount`, `400 unknown_outcome` (with `outcomeKeys`),
  `404 market_not_found`.

## Preview: `POST /api/bazaar/v1/markets/draft` (writes nothing)

- Body: `walletAddress`, `kind` (default `will_it_happen`), `title`, `criteria`,
  `description`, `sources [{ url, note }]`, `currency` (`usdc`), `visibility`, `closeAt`
  or `closeIn` (`90m`, `36h`, `7d`, `2w`), `resolveDeadlineAt` (default: 72h after the
  close), `outcomeKeys`, `category`, `createdVia` (`bankr` for a person on X), `xHandle`,
  `sourceTweetId`.
- Response: `advisory: true`, `valid`, `issues [{ field, code, message }]`,
  `market { ..., autoRefundAt }`, `creator`,
  `terms { fee, feeModel, settlementFeeBps, entryFeeBps, minBet, resolvedBy, immutability, guarantee }`,
  `similar [{ id, title, url, closeAt, autoRefundAt, pool, impliedOddsPct, similarity }]`,
  `checkedAtConfirm []`, `confirm { method, url, confirmBy, body }` or null.

## Create: `POST /api/bazaar/v1/markets` (wallet proof `create_market`)

- Body: the preview's `confirm.body`, then plus `proof`.
- `201` (new) or `200` with `replayed: true` (that post already made it): `market`
  (with `privateSlug` for a private market), `limits`, `replayed`; for
  `createdVia: "bankr"` also `creator { creatorId, wallet, handle, verified, via }` and
  `handleClaim`; for an agent, `agent`.

## Resolve: `POST /api/bazaar/v1/markets/{id}/resolve` (wallet proof `resolve_market`)

- Body: `{ walletAddress, outcome, note (1 to 2000 characters), evidence [{ url, note }] }`.
- `200`: `marketId`, `settledOutcome`, `refundedUnbackedOutcome`, `fullRefund`, `paid`,
  `payouts [{ bettorId, kind, amount }]`,
  `fees { creator, referral, protocol, total, model, bps, capped, creatorShareBps }`,
  `dust`, `unpayable []`, `manifestHash`.

## Void: `POST /api/bazaar/v1/markets/{id}/void` (wallet proof `void_market`)

- Body: `{ walletAddress, note (10 to 500 characters) }`.
- `200`: `marketId`, `voided`, `reason: "creator"`, `note`, `refunded`,
  `refunds [{ bettorId, amount }]`, `fees`, `unpayable []`, `manifestHash`.

## Results: `GET /api/bazaar/v1/markets/{id}/results`

- Not settled: `settled: false`, `state`, `market`, `timing`, `links`.
- Settled: `outcome`, `refundedInFull`, `resolution { resolvedBy, note, evidence, resolvedAt }`,
  `void { reason, note }`,
  `totals { staked, paidOut, retained, bets, bettors, payoutLines, pendingLines }`,
  `fees { take, creator, referral, protocol, returnedToBettors }`,
  `payouts [{ kind, amount, wallet, status, paidAt, txHash, txUrl }]` where `status` is
  `paid`, `pending`, `held` or `unpayable`, `manifestHash`, and `announcement` (a
  ready-to-post paragraph).

## To resolve: `GET /api/bazaar/v1/creators/{id}/to-resolve`

- `creator`, `guaranteeHours`, `count`, and `markets[]`: a list row plus
  `resolveBy { resolveDeadlineAt, autoRefundAt, secondsToDeadline, secondsToAutoRefund, phase, canResolveNow }`.
- `phase`: `due` (resolve now), `overdue` (past the deadline, still resolvable),
  `awaiting_close` (betting ended; the tick closes it within about 10 minutes),
  `auto_refund_due` (too late). Public markets only.

## A creator's record: `GET /api/bazaar/v1/creators/{id}?markets=`

- `creator { creatorId, wallet, handle, agentLabel, profileUrl }`.
- `stats { marketsCreated, marketsResolved, autoRefunded, onTimePct, medianResolveSeconds, tier, totalVolume, distinctBettors, followers }`.
- `score`, `badges []`, `agent` and `earnings` (wallet creators), `markets []`.
- `404 creator_not_found`: no record and no public markets under that reference.

## Positions: `GET /api/bazaar/v1/positions?wallet=`

- `wallet`, `count`, `open []`, `settled []`, each
  `{ marketId, title, state, resolvedOutcome, currency, stake, bets [{ betId, outcomeKey, stake, fee, createdAt }], payouts [{ kind, amount, credited, state, note, txHash }] }`.
- A payout `state` is `paid`, `held`, `unpayable` or `pending`.

## Standing and registration: `GET /api/bazaar/v1/register?wallet=` and `POST` (wallet proof `register_agent`)

- `registered`, `wallet`, `actorId`, `label`, `operatorContact`,
  `bond { state, required, retired }`, `listingFee { state, required, retired }`,
  `canCreate`, `openMarketCount`, `createdMarketCount`, `cleanResolutionCount`,
  `registeredAt`. The POST adds `nextSteps []`.
- POST body: `{ walletAddress, operatorContact (3 to 200 characters), label (2 to 64) }`.
  Registering records the Bazaar terms for the wallet.

## Fee schedule: `GET /api/bazaar/v1/fees`

- `model`, `summary`, `settlementFeeBps`, `settlementFeePct`,
  `settlement { bps, pct, base, paidFrom, cappedAt }`, `entryFeeBps`, `noFeeOn []`,
  `minBet`, `caps { note }`, `guarantee { hours, rule }`, `creatorShare { enabled }`,
  `referralShare { enabled, bps, pct, termDays }`, `agentBond { required }`,
  `agentListingFee { required }`, `createLimits { ..., summary }`,
  `timing { minCloseHours, maxCloseDays, defaultResolveDeadlineHours, maxResolveDeadlineDays, betLockSeconds }`,
  `maxOutcomes`.

## Earnings: `GET /api/bazaar/v1/earnings?wallet=` and `POST` (wallet proof `claim_earnings`)

- GET: `claimable`, `claimed`, `refunded`, `forfeited`, `marketCount`,
  `referral { claimable, claimed, marketCount }`.
- POST body `{ walletAddress }` → `{ noop, claimed, marketIds, referralClaimed, referralMarketIds }`.

## Share link: `POST /api/bazaar/v1/ref/register` (wallet proof `register_ref_link`)

- Body `{ walletAddress, marketId }` → `201 { refCode, shareUrl, quickUrl }`.

## Leaderboards: `GET /api/bazaar/boards?board=&limit=`

- `board`: `weekly`, `season`, `alltime`, `category`, `rising`.
- `board`, `weekKey`, `rows [{ rank, creatorId, handle, tier, score }]`.
