# Standing bets

A standing bet is a wallet's signed, server-enforced instruction: which markets,
which outcome, how much per bet, how many bets, how much in total, until when. It
holds no money and moves none by itself. Every bet it produces is paid by the same
wallet over x402 on the ordinary bet route, and the server holds the bound: before
a stake is relayed it reserves a fill under the grant's row lock, so two bets can
never spend past it together.

## Terms

```json
{
  "walletAddress": "0x… (the user's own Bankr wallet)",
  "scope": { "creator": "0x… or @handle" },
  "outcomeKey": "yes",
  "amountPerBet": "2.00",
  "maxTotal": "20.00",
  "maxBets": 10,
  "expiresIn": "7d",
  "cadence": "once_per_market",
  "trigger": { "oddsBelowPct": 40 }
}
```

- `scope`: exactly one of `{ "marketId" }` (one market) or `{ "creator" }` (every
  public USDC market that creator's wallet opens AFTER the grant, with this outcome).
- `amountPerBet` at least the $0.50 minimum bet; there is no maximum. `maxTotal` at
  least `amountPerBet`. `maxBets` 1 to 100.
- `expiresIn` ("90m", "36h", "7d", "2w") or `expiresAt` (ISO-8601), at most 30 days.
- `cadence`: `once_per_market` (default) or `daily` (one market only: a bet each UTC day).
- `trigger` (optional): `oddsBelowPct` and/or `oddsAbovePct`, whole percent 1 to 99,
  on the grant's own outcome, read from the live pool. A market with no bets has no
  odds, so a trigger is not met on it.
- At most 10 active standing bets per wallet.

## Draft, then create

`POST /api/bazaar/v1/standing-bets/draft` (writes nothing) answers `valid`, every
issue, the `summaryLine` and a `confirm` block:

```json
{
  "valid": true,
  "summaryLine": "$2.00 on YES in each new market by 0x…, when YES odds are below 40%, up to 10 bets / $20.00, until 2026-10-16 00:00 UTC",
  "confirm": {
    "method": "POST",
    "url": "https://bazaar.playhunch.xyz/api/bazaar/v1/standing-bets",
    "body": { "walletAddress": "0x…", "scope": { "creator": "0x…" }, "expiresAt": "2026-10-16T00:00:00.000Z", "…": "…" },
    "proof": { "action": "create_standing_bet", "market": "-", "intent": "standing bet: $2.00 on YES …" }
  },
  "replyText": "Standing bet, not on yet: …"
}
```

The confirm body names the creator by wallet and the expiry as an absolute time, so
what the user confirms is exactly the grant. On confirm, POST that body with a
wallet proof whose Intent is `standing bet: <summaryLine>` and whose Market is the
body's `scope.marketId`, or `-` for a creator grant. `node scripts/bazaar.mjs
standing-bet-create --json '<terms>' --confirm` does both steps and checks the
Intent before signing.

## Check, then bet

`GET /api/bazaar/v1/standing-bets/{id}/check` answers:

- `status`: `due`, `not_due`, `exhausted`, `expired` or `revoked`, with `reason` and
  a `message` sentence;
- `bet` when due: exactly the request to send, including the server-derived
  `idempotencyKey` `sb:<grant>:<market>:<period>`, where the period is `m` (once per
  market) or `d:YYYYMMDD` (daily, UTC);
- `usage` and `remaining` (bets and money).

One due bet per check: the oldest eligible market. Then
`POST /api/bazaar/v1/markets/{marketId}/bets` with `{ walletAddress, outcomeKey,
amount, idempotencyKey, standingBetId }` and the usual x402 payment. The bet route
refuses anything that is not that bet (`standing_bet_mismatch`, with a `reason`:
`wallet_mismatch`, `outcome_mismatch`, `amount_mismatch`, `key_mismatch`,
`out_of_scope`, `market_unavailable`, `outcome_missing`), anything a spent or
stopped grant would place (`standing_bet_exhausted`, `standing_bet_inactive`), and a
market not due (`standing_bet_not_due`), all before any challenge, so nothing is
charged. A replay of a bet that stands answers the original bet.
`node scripts/bazaar.mjs standing-bet-run --id <id>` is check-then-bet in one command,
for an automation.

## List, read, revoke

- `GET /api/bazaar/v1/standing-bets?wallet=`: newest first, each with `status`,
  `usage`, `remaining` and `summaryLine`, plus `activeCount` and `maxActive`.
- `GET /api/bazaar/v1/standing-bets/{id}`: one grant and its fills (market, period,
  reserved or placed, the bet id).
- `DELETE /api/bazaar/v1/standing-bets/{id}` with `{ walletAddress, standingBetId }`
  and a wallet proof (`revoke_standing_bet`, Intent `revoke standing bet <id>`). The
  body's id must equal the path's. Idempotent; placed bets stand.
