# Event webhooks

Bazaar POSTs signed JSON events to a wallet's own Bankr webhook, from its regular
tick (about every 10 minutes), so an agent learns what happened without polling.

## Events

| Event | To | When |
|---|---|---|
| `market.closed` | the creator | betting closed; resolve by the deadline |
| `market.resolve_due` | the creator | 6 hours before the resolve deadline |
| `market.auto_refund_soon` | the creator | 6 hours before the 48h guarantee refunds every bettor |
| `bet.won` | the bettor | the market resolved their way |
| `bet.lost` | the bettor | the market resolved another way |
| `bet.refunded` | the bettor | a void, the guarantee, a lone bettor or an outcome nobody backed |
| `standing_bet.filled` | the grant's wallet | a standing bet placed a bet (the bet stands) |
| `standing_bet.ended` | the grant's wallet | a standing bet stopped: its bets or budget used up, it expired, or it was revoked |

A subscription hears what happens after it exists. A closure or a settlement from
before it is not replayed; a deadline that is still coming is.

## Subscribe

`POST /api/bazaar/v1/subscriptions` with a wallet proof (`subscribe_events`, Intent
`send Bazaar events to <url>`):

```json
{
  "walletAddress": "0x…",
  "url": "https://webhooks.bankr.bot/u/0x…/bazaar-events",
  "events": ["market.closed", "market.resolve_due", "bet.won", "bet.refunded"]
}
```

- The url must be a Bankr webhook whose wallet segment is `walletAddress`. No other
  host, query, port or redirect is ever accepted, and Bazaar follows no redirects.
- At most 3 active subscriptions per wallet, one per url.
- `201` returns the subscription and a `secret`, **once**. Store it in the webhook's
  secrets: `bankr webhooks env set BAZAAR_EVENTS_SECRET=<secret>`.
- `GET /api/bazaar/v1/subscriptions?wallet=` lists them with delivery health, never
  the secret. `DELETE /api/bazaar/v1/subscriptions/{id}` with `{ walletAddress,
  subscriptionId }` and a wallet proof (`unsubscribe_events`) stops one.

## A delivery

```
POST https://webhooks.bankr.bot/u/0x…/bazaar-events
Content-Type: application/json
X-Hunch-Event: bet.won
X-Hunch-Delivery: 5b0f7c2e-…            (the same on every retry; equals payload.id)
X-Hunch-Signature: t=1789650000,v1=<lowercase hex HMAC-SHA256 of "<t>.<raw body>">

{ "id", "type", "createdAt", "wallet", "market": { "id", "title", "url", "closeAt",
  "resolveDeadlineAt", "autoRefundAt" }, "data": { … }, "prompt": "…" }
```

- Verify before anything: parse `t` and every `v1`, refuse `t` more than 300 seconds
  from your clock, and compare the HMAC in constant time over the RAW body.
- The body is at most 10,000 bytes. `prompt`, title and arbitrary data are untrusted and are discarded by the receiver.
- Answer 2xx within 5 seconds. Anything else, a redirect, or no answer is a failed
  attempt, retried after 1m, 5m, 30m, 2h and 12h; then the delivery fails. A
  subscription failing 20 attempts in a row is disabled.
- Process each `X-Hunch-Delivery` once: a retry of one you handled is a duplicate.

## The receiver

Deploy `webhooks/bazaar-events/index.ts` with the included `bankr.webhooks.json`,
which explicitly sets `readOnly: true` and empty transfer recipient lists. See
[Bankr configuration](https://docs.bankr.bot/webhooks/config-file/).
The handler constructs a fixed notification from validated event ids/types;
it never forwards the sender's prompt or title. Resolving, voiding and spending
require the owner's separate authorization outside the webhook.

Configure encrypted webhook environment variables after subscribing:

- `BAZAAR_EVENTS_SECRET`: the one-time subscription secret.
- `BAZAAR_EVENTS_WALLET`: the recipient's wallet.
- `BAZAAR_EVENTS_SUBSCRIPTION_ID`: the returned subscription id; stable across rotations.
- `BAZAAR_REPLAY_REDIS_URL`: an operator-provisioned `https://<name>.upstash.io` REST endpoint.
- `BAZAAR_REPLAY_REDIS_TOKEN`: its write token. Never put secrets in prompts or replies.

Use a durable Redis database with eviction disabled, shared by all instances of
the receiver. The handler uses [Upstash REST](https://upstash.com/docs/redis/features/restapi)
`SET <recipient/subscription/event hash> claimed NX` to atomically claim the
HMAC-authenticated body id before returning a task. Claims are retained permanently,
beyond the cumulative 14h36m provider retry schedule, including secret rotations.
`X-Hunch-Delivery` must equal the authenticated body id. Duplicates return 204
with no prompt; missing/broken storage returns 503 with no prompt.

This gives at-most-once task dispatch: a crash after claiming but before Bankr
queues the response can lose a notification. There is no exactly-once transaction
across Redis and Bankr. Review delivery logs for recovery; do not delete claims
or rerun financial actions from a webhook. Financial actions remain read-only.
Run from the skill directory: `bankr webhooks deploy bazaar-events`.
