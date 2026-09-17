# Wallet proofs: signing a Bazaar write

Every Bazaar write that moves no money is authorized by a free EIP-191
`personal_sign` over one fixed message. A creator's wallet is public on every
market card, so naming a wallet proves nothing; signing this message proves the
named wallet asked for exactly this request. Bets are not signed this way: a bet
is paid over x402, and the payment is the proof (see `bets.md`).

## The flow

1. Send the write with no `proof` member.
2. The server answers `401`:

   ```json
   {
     "error": "wallet_proof_required",
     "message": "This write needs a wallet proof. Sign challenge.message with personal_sign from walletAddress and resend the same body with proof.",
     "challenge": {
       "scheme": "eip191-personal-sign",
       "message": "<the 13-line message below>",
       "proof": { "issuedAt": "<ISO-8601 UTC>", "nonce": "<nonce>" },
       "payloadSha256": "<hex>",
       "expiresAt": "<ISO-8601 UTC>"
     },
     "template": "<the template below>",
     "windowSeconds": 300,
     "docs": "https://bazaar.playhunch.xyz/api/bazaar/v1/getting-started"
   }
   ```

3. Run every check in [Before you sign](#before-you-sign). Any failure: do not sign.
4. Sign `challenge.message` exactly, with the requesting user's own wallet:

   ```
   POST https://api.bankr.bot/wallet/sign
   { "signatureType": "personal_sign", "message": "<challenge.message>" }
   → { "success": true, "signature": "0x...", "signer": "0x...", "signatureType": "personal_sign" }
   ```

   `signer` must be the body's `walletAddress`. The Bankr API key goes to
   `https://api.bankr.bot` and nowhere else.
5. Resend the same body with
   `"proof": { "signature": "<signature>", "issuedAt": "<challenge.proof.issuedAt>", "nonce": "<challenge.proof.nonce>" }`.

## The message template

```
bazaar.playhunch.xyz asks you to sign a Bazaar action.

Intent: <intent>
Action: <action>
Market: <market id, or ->
Wallet: <lowercase 0x wallet>
Chain ID: 8453
Payload SHA-256: <lowercase hex sha256 of the canonical JSON body without proof>
Issued At: <ISO-8601 UTC>
Nonce: <nonce>
Version: 1

Free to sign. Sends no transaction. Accepted once, within 5 minutes of Issued At.
```

## Actions

| Action | Endpoint | Market line | Intent | Signed by this skill |
|---|---|---|---|---|
| `create_market` | `POST /api/bazaar/v1/markets` | `-` | `create market "<title>"` | yes |
| `resolve_market` | `POST /api/bazaar/v1/markets/{id}/resolve` | the market id | `resolve as "<outcome>"` | yes |
| `void_market` | `POST /api/bazaar/v1/markets/{id}/void` | the market id | `void with note "<note>"` | yes |
| `register_agent` | `POST /api/bazaar/v1/register` | `-` | `register agent "<label>"` | yes |
| `claim_earnings` | `POST /api/bazaar/v1/earnings` | `-` | `claim earnings` | yes |
| `register_ref_link` | `POST /api/bazaar/v1/ref/register` | the body's `marketId` | `mint a share link` | yes |
| `create_recurring` | `POST /api/bazaar/v1/markets/{id}/recurring` | the market id | `start a <cadence> recurring stream` | never |
| `stop_recurring` | `DELETE /api/bazaar/v1/markets/{id}/recurring` | the market id | `stop the recurring stream` | never |
| `follow_creator` | `POST /api/bazaar/v1/creators/{id}/follow` | `-` | `follow <creator wallet lowercase>` | yes |
| `unfollow_creator` | `DELETE /api/bazaar/v1/creators/{id}/follow` | `-` | `unfollow <creator wallet lowercase>` | yes |
| `report_market` | `POST /api/bazaar/v1/markets/{id}/report` | the market id | `report as "<reason>"` | yes |
| `create_standing_bet` | `POST /api/bazaar/v1/standing-bets` | the body's `scope.marketId`, or `-` | `standing bet: <server summary line>` | yes |
| `revoke_standing_bet` | `DELETE /api/bazaar/v1/standing-bets/{id}` | `-` | `revoke standing bet <id>` | yes |
| `subscribe_events` | `POST /api/bazaar/v1/subscriptions` | `-` | `send Bazaar events to <url>` | yes |
| `unsubscribe_events` | `DELETE /api/bazaar/v1/subscriptions/{id}` | `-` | `stop Bazaar events <id>` | yes |

An Intent value is the body field with control characters and repeated spaces
collapsed, double quotes turned into single quotes, and cut to 80 characters
followed by an ellipsis; a missing field is `-`. A follow's Intent names the
creator from the path instead: their wallet in lowercase, or the `creatorId`
`GET /api/bazaar/v1/creators/{id}` returns for a creator without one.
A standing bet's Intent is the server's own summary line for the body (the
`summaryLine` `POST /api/bazaar/v1/standing-bets/draft` returns), never cut: sign
the draft's `confirm.body` with its `confirm.proof.intent`, or the message a 401
challenge carries.

## Canonical JSON and the payload hash

`Payload SHA-256` is the lowercase hex SHA-256 of the UTF-8 canonical JSON of the
request body without its top-level `proof` member: object keys sorted ascending,
no whitespace, `undefined` members dropped, arrays kept in order, numbers as
JavaScript's `JSON.stringify` writes them. `canonicalJson` in `scripts/bazaar.mjs` is
exactly the server's algorithm.

## Before you sign

Sign only when every line holds. These mirror `x402-registry.json` →
`signingPolicy.walletProof.preSignChecks`, and `scripts/bazaar.mjs` →
`checkProofChallenge` runs them for every command.

1. The response is `401 wallet_proof_required` and `challenge.scheme` is `eip191-personal-sign`.
2. `challenge.message` is exactly 13 lines. Line 1 is the domain line, lines 2 and 12 are empty, line 13 is the free-to-sign line. No other text anywhere.
3. `Action:` is the write the user asked for, and it is one of the thirteen actions this skill signs.
4. `Intent:` matches it: the exact intent for claim and share link, the action's prefix otherwise, and for a resolve exactly `resolve as "<the outcome key the user chose>"`.
5. `Market:` is the market id the Bazaar API returned for the market being acted on, or `-` for create, register and claim.
6. `Wallet:` is the requesting user's own Bankr wallet, lowercase, and equals the body's `walletAddress`.
7. `Chain ID: 8453` and `Version: 1`.
8. `Payload SHA-256:` equals the hash of the body you are about to send (when you can compute it). The body does not change after the challenge.
9. `Issued At:` equals `challenge.proof.issuedAt` and is within 5 minutes of now; `Nonce:` equals `challenge.proof.nonce` (16 to 128 of `A-Z a-z 0-9 _ -`).
10. Sign with `personal_sign` only. Never typed data, never a transaction, never a message that fails a check above.

## Retries

- A nonce is accepted once per wallet. **Any retry starts over:** resend without a
  proof and sign the fresh challenge.
- `401 wallet_proof_expired`: the issue time is more than 5 minutes from server time.
  Start over.
- `401 wallet_proof_replayed`: that nonce was used. Start over.
- `401 wallet_proof_invalid`: malformed, or not signed by `walletAddress` for this
  exact request. Stop and report it; do not sign a different body to make it pass.
- `503 wallet_proof_unavailable`: Base or the nonce store could not be asked. Resend
  the same proof once, shortly, inside its 5 minutes.
- `400 invalid_wallet`: the `walletAddress` field is malformed.

A create replayed from the same post with a fresh proof answers `200` with
`replayed: true` and the market that post already made.

## Worked example: resolve a market as YES

The body:

```json
{"walletAddress":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8","outcome":"yes","note":"CoinGecko closed ETH at 4,112 on Sep 19, 2026.","evidence":[{"url":"https://www.coingecko.com/en/coins/ethereum/historical_data"}]}
```

Its canonical JSON:

```json
{"evidence":[{"url":"https://www.coingecko.com/en/coins/ethereum/historical_data"}],"note":"CoinGecko closed ETH at 4,112 on Sep 19, 2026.","outcome":"yes","walletAddress":"0x70997970c51812dc3a010c7d01b50e0d17dc79c8"}
```

For market `3f1c9a52-6d0e-4b7a-9f51-2c8e1d7b4a60`, issued at
`2026-09-19T21:04:12.000Z` with nonce `q3Jx9vT2mKp7LwZ4bN8cRd1s`, the message is:

```
bazaar.playhunch.xyz asks you to sign a Bazaar action.

Intent: resolve as "yes"
Action: resolve_market
Market: 3f1c9a52-6d0e-4b7a-9f51-2c8e1d7b4a60
Wallet: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8
Chain ID: 8453
Payload SHA-256: a94c0f76eabd1255d767189423f70792ec0618d914b3d65a4258cc60c4d0d61b
Issued At: 2026-09-19T21:04:12.000Z
Nonce: q3Jx9vT2mKp7LwZ4bN8cRd1s
Version: 1

Free to sign. Sends no transaction. Accepted once, within 5 minutes of Issued At.
```

The resent body is the same body plus
`"proof":{"signature":"0x...","issuedAt":"2026-09-19T21:04:12.000Z","nonce":"q3Jx9vT2mKp7LwZ4bN8cRd1s"}`.
