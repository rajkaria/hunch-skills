# Bazaar skill 3.1.0 security regression coverage

Run from the public skills repository with Node 22.18+:

```sh
npm test
```

No dependencies, API keys, network calls, real signatures or money are required.
The CLI remains compatible with Node 18+; Node 22.18+ is needed only to import the
TypeScript webhook in the public tests. GitHub Actions runs the same suite.

| Finding | Implementation | Regression evidence |
| --- | --- | --- |
| Standing-bet authorization | Retained user/wallet-bound grant, exact amount/outcome/scope/expiry, local revocation, atomic total/count reservation, derived cadence key | Unknown $200 grant, amount/outcome/key/market mismatch, creator/trigger checks, concurrent distinct intents, separate total/count limits, failed remote revoke, expiry during challenge |
| Preview consent | Immutable normalized body/hash/expiry and trusted user/wallet; explicit preview id; no second draft | Both create flows resist changed server terms; missing/expired/tampered/cross-user/cross-wallet previews refused; successful retry cannot reset budget |
| Payment retries | Wallet/key lock, fsynced atomic state, pre-sign pending marker, permanent completed record | Two processes request one signature; dropped response reuses exact header; uncertain signer response blocks re-signing; old key collisions separated; legacy state fails closed |
| Webhook instructions | Fixed local notification using validated ids/type; supplied prompt/title/data discarded; explicit read-only configuration | Authenticated transfer instruction absent from task; permissions checked |
| Webhook replay | Permanent atomic Redis SET NX, scoped by wallet/subscription/authenticated event id | Parallel/sequential duplicates return no prompt; invalid HMAC/recipient never claims; failed store returns 503 |

The suite also verifies payment pins, redirect refusal and Bankr key isolation.

Operational boundaries: all wallet runners must share one durable local state
directory on one host. Filesystem locks are never automatically stolen. Pending
signatures, crashed locks and outstanding legacy authorizations require operator
reconciliation. Do not delete state or use a new idempotency key to bypass a refusal.
Server-only historical grants need fresh local approval. Already-deleted legacy
payment history cannot be reconstructed.

Webhook Redis must be durable with eviction disabled; claims do not expire. The
receiver provides at-most-once dispatch, not transactional exactly-once delivery
across Redis and Bankr. A crash after claiming may lose a notification. It cannot
spend funds. See events.md for provisioning and recovery requirements.

Market metadata and pool facts still depend on Hunch. Payments go to the pinned
Hunch settlement account, not a market escrow enforcing payouts/refunds. These
client tests are not a backend settlement audit or proof of payout solvency.

## Native Bankr X creation (3.1.0)

The hosted creation bridge uses the runtime native `sign_data` personal-sign
tool, verified by read-only tool discovery in Bankr Terminal. It does not use
API credentials, guessed requesting-user IDs, or sandbox-local persistence.
Preview records are saved using Bankr wallet-scoped `write_file`/`read_file`;
the SHA-256 commitment in the original bot preview reply binds the exact body,
identity and expiry. Confirmation must come from the same authenticated user.
The file itself is untrusted, and changing it cannot preserve its commitment.

The bridge validates Bazaar's entire challenge before handing it to the native
signer, and again before submission. The server verifies the signature and
nonce. Source-post uniqueness and creator ownership support response-loss
reconciliation. The script never signs or transfers funds itself.

`test/native.test.mjs` covers empty-env fresh runtimes, independent wallets,
identity and content substitution, expiry, malicious challenges, dropped
responses, source ownership, fixed fees, and shell-safe base64url transport.
Node and Bun pass all 46 script tests. The production draft and unsigned
create challenge were checked without publishing a market. A confirmed
end-to-end X publication remains the release acceptance check; no claim of
verified public market creation is made by these tests.
