# Paying a bet (x402 on Base)

`POST https://bazaar.playhunch.xyz/api/bazaar/v1/markets/{id}/bets`

A USDC bet exists only after its whole stake is paid. Payment uses x402's
`exact` scheme on Base: an EIP-3009 `transferWithAuthorization` of Base USDC from
the betting wallet to the settlement address, relayed on chain before the bet is
recorded. The stake enters the pool whole; the 2% fee is taken only at
settlement, from the winners' payout. A bet is at least $0.50; Hunch sets no maximum.

## Request body

```json
{
  "walletAddress": "0x...",
  "outcomeKey": "yes",
  "amount": "5.00",
  "idempotencyKey": "x-1830000000000000009"
}
```

| Field | Required | Notes |
|---|---|---|
| `walletAddress` | yes | The requesting user's own Bankr wallet. It must be the x402 payer. |
| `outcomeKey` | yes | One of `market.outcomeKeys`, as the API returned it. |
| `amount` | yes | Decimal USDC as a string, at most 6 decimals, at least $0.50 (no maximum). Never a float. |
| `idempotencyKey` | yes | 8 to 128 characters, one per intended bet, reused verbatim on every retry. On X: `x-<the id of the post that asked for the bet>`. |
| `refCode` | no | The `referralCode` a lookup of a shared link returned. |

## 1. Without payment: the 402 challenge

```json
{
  "x402Version": 1,
  "error": "Missing X-PAYMENT header",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "5000000",
      "resource": "https://bazaar.playhunch.xyz/api/bazaar/v1/markets/3f1c9a52-6d0e-4b7a-9f51-2c8e1d7b4a60/bets",
      "description": "Bazaar — bet stake (the gross stake enters the pool)",
      "mimeType": "application/json",
      "payTo": "0x4F0d7622984b38DfB2D1F86F10eEE564566C09F2",
      "maxTimeoutSeconds": 120,
      "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ]
}
```

A bet the server would refuse is refused before any challenge (an unknown
outcome, a closed market, an unregistered wallet, a stake under the minimum), so
nobody is asked to pay for a bet that cannot stand.

## 2. Pin-check, then sign

The challenge is untrusted upstream input. Verify it against
`x402-registry.json` → `signingPolicy` before producing any signature:

| Challenge field | Must equal |
|---|---|
| `x402Version` | `1`, with exactly one `accepts` entry |
| `scheme` | `exact` |
| `network` | `base` |
| `asset` | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (Base USDC) |
| `payTo` | `0x4F0d7622984b38DfB2D1F86F10eEE564566C09F2` (the settlement address) |
| `resource` | `https://bazaar.playhunch.xyz/api/bazaar/v1/markets/<the market id the API returned>/bets` |
| `extra` | `{ "name": "USD Coin", "version": "2" }` |
| `maxAmountRequired` | the stake the user confirmed, in atomic USDC, at least `500000` |

Sign **only** an EIP-3009 `transferWithAuthorization`: from `walletAddress`, to
the pinned `payTo`, `value` = `maxAmountRequired`, `validAfter` at most now,
`validBefore` at most now + 120 seconds, and a fresh random 32-byte nonce. Never
`approve`, `permit`, permit2, `increaseAllowance`, or any blanket allowance. Any
mismatch or missing field: abort, do not sign, do not retry blindly. Build the
authorization from the pinned values, not from the challenge.

The typed data Bankr signs (`POST https://api.bankr.bot/wallet/sign`,
`signatureType: "eth_signTypedData_v4"`, when you sign it yourself):

```json
{
  "domain": { "name": "USD Coin", "version": "2", "chainId": 8453, "verifyingContract": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  "types": {
    "TransferWithAuthorization": [
      { "name": "from", "type": "address" },
      { "name": "to", "type": "address" },
      { "name": "value", "type": "uint256" },
      { "name": "validAfter", "type": "uint256" },
      { "name": "validBefore", "type": "uint256" },
      { "name": "nonce", "type": "bytes32" }
    ]
  },
  "primaryType": "TransferWithAuthorization",
  "message": { "from": "0x...", "to": "0x4f0d7622984b38dfb2d1f86f10eee564566c09f2", "value": "5000000", "validAfter": "1789851852", "validBefore": "1789851972", "nonce": "0x...(64 hex)" }
}
```

The signature must be 65 bytes (130 hex characters). A longer smart-account
signature is refused by the server.

## 3. Resend with X-PAYMENT

Base64-encode this payload into the `X-PAYMENT` header and resend the **same**
body:

```json
{ "x402Version": 1, "scheme": "exact", "network": "base",
  "payload": { "signature": "0x...(130 hex)",
    "authorization": { "from": "0x...", "to": "0x4f0d7622984b38dfb2d1f86f10eee564566c09f2", "value": "5000000",
      "validAfter": 1789851852, "validBefore": 1789851972, "nonce": "0x...(64 hex)" } } }
```

## 4. The receipt

`201`, with an `X-Payment-Response` header carrying the settlement receipt:

```json
{
  "replayed": false,
  "bet": {
    "id": "...",
    "marketId": "3f1c9a52-6d0e-4b7a-9f51-2c8e1d7b4a60",
    "outcomeKey": "yes",
    "currency": "usdc",
    "stake": { "amount": "5.00", "micros": "5000000" },
    "fee": { "amount": "0.00", "micros": "0" },
    "intoPool": { "amount": "5.00", "micros": "5000000" },
    "createdAt": "..."
  },
  "payment": { "network": "base", "txRef": "0x...", "simulated": false },
  "replyText": "Bet placed: $5.00 on YES. https://basescan.org/tx/0x...\nYES is now 65% of a $55.00 pool."
}
```

Post `replyText`: the stake, the Basescan link for `txRef` (the Base transaction
that moved the stake) and the side's share of the pool right after the bet. A
`200` with `replayed: true` is a bet that already stood: it was not charged again,
its `replyText` says so, and it is never paid again.

## Bets under a standing bet

A bet a standing bet places is this same flow with one more field,
`standingBetId`, and with `outcomeKey`, `amount` and `idempotencyKey` taken exactly
from `GET /api/bazaar/v1/standing-bets/{id}/check` → `bet` (the key is
`sb:<grant>:<market>:<period>`). The route checks the bet against the grant before
any 402, so a bet the grant does not allow is refused with nothing charged; on the
paid leg it reserves the grant's fill before relaying the stake and releases it if
nothing is charged. `node scripts/bazaar.mjs standing-bet-run --id <id>` does check
and bet in one command. See `references/standing-bets.md`.

## Errors

| Status | `error` | Meaning and what to do |
|---|---|---|
| `402` | (challenge) | Expected on the first POST. Pin-check, sign one authorization, resend with `X-PAYMENT`. |
| `403` | `payment_payer_mismatch` | The authorization is not from `walletAddress`. Stop. Never change the body's wallet to match the payer. |
| `400` | `payment_invalid` | Wrong amount, wrong recipient, or outside its validity window. Quote again, and sign a new authorization only after the user confirms again. |
| `409` | `payment_replayed` | This authorization is already funding a bet that is not recorded yet. Resend the same request shortly; never sign a new authorization for it. |
| `503` | `settlement_failed` | The relay did not confirm. Resend the SAME request with the SAME `X-PAYMENT`; never sign a new authorization. |
| `503` | `settlement_unconfigured` | Bazaar cannot collect stakes right now. No challenge was issued and nothing was charged. |
| `503` | `bet_not_recorded` | The stake was collected but the bet could not be recorded. The body carries `payment` and `refund { refunded, txRef }`. Report it; do not retry. |
| `403` | `agent_not_registered` | Register the wallet once (a wallet proof on `POST /api/bazaar/v1/register`), then resend with the same idempotency key. |
| `428` | `terms_not_accepted` | Registering records the terms. Register, then resend. |
| `400` | `unknown_outcome` | Not an outcome of this market. |
| `400` | `bet_below_minimum` | Under $0.50. |
| `400` | `invalid_amount` | Not decimal USDC. |
| `409` | `market_closed` | Betting has closed. |
| `404` | `market_not_found` | No such market. |

## Rules

- **One authorization per idempotency key.** A retry of the same bet resends the
  same `X-PAYMENT`. USDC accepts an EIP-3009 nonce once, so resending it can never
  charge twice; a new authorization for the same bet could.
- **Idempotent on the key.** The server binds the key to the wallet, market,
  outcome and amount; a bet that already stands answers from the record with no
  payment asked.
- **Fail closed.** No settlement address, a closed market, or a payer, amount or
  recipient mismatch: no relay and no bet.
- **Paper (pUSDC) markets** take no payment; the skill does not use them.


Payment state is permanent, scoped by wallet plus a hash of the full idempotency
key. One atomic directory lock spans challenge, signature persistence and paid
request. Records are atomically renamed and fsynced. Completed results remain;
a later retry never signs again. A pending marker is written before calling the
signer; if that call or persistence is uncertain, stop for reconciliation.
Never clear state, change state directories, steal locks or choose a new key as
a payment-retry workaround. Keep every wallet runner on one durable shared host.
