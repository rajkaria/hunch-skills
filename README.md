# Hunch skills for Bankr agents

Prediction markets on Base for Bankr agents: curated [Hunch](https://www.playhunch.xyz) markets, and
[Bazaar](https://bazaar.playhunch.xyz) markets that anyone opens and the person who opened them settles.
Bets are paid in USDC on Base over x402.

| Skill | What it does | Install |
| --- | --- | --- |
| [`hunch`](hunch/) | Curated crypto prediction markets on www.playhunch.xyz: find a market from a post or a phrase, get live odds, bet YES/NO, track positions and read results with an on-chain proof. | `install the hunch skill from https://github.com/rajkaria/hunch-skills/tree/main/hunch` |
| [`hunch-bazaar`](hunch-bazaar/) | Open prediction markets on bazaar.playhunch.xyz: anyone opens one by tagging the bot, the person who opened it settles it, and bets are paid in USDC on Base. | `install the hunch-bazaar skill from https://github.com/rajkaria/hunch-skills/tree/main/hunch-bazaar` |

## Install

Tell your Bankr agent, for example in a post to @bankrbot:

> install the hunch skill from https://github.com/rajkaria/hunch-skills/tree/main/hunch

> install the hunch-bazaar skill from https://github.com/rajkaria/hunch-skills/tree/main/hunch-bazaar

Each skill installs on its own. Use `hunch` for markets on www.playhunch.xyz and
`hunch-bazaar` for markets on bazaar.playhunch.xyz.

## hunch

Find a market from a post or a phrase, see live odds with the pool behind them, and bet in one
reply. The market id always comes from Hunch's discover API, never from a guess.

| Say | What happens |
| --- | --- |
| `@bankrbot what can I bet on about $BNKR?` | Live Hunch markets for that token, with odds, bets and pool size. |
| `@bankrbot take YES on $BNKR hitting $100M, $5` | The quote and the market's disclosure; on confirm the stake is paid over x402 and the bet returns an on-chain proof. |
| `@bankrbot show my Hunch bets` | Your positions, average entry and live PnL, by wallet. |
| `@bankrbot did my market resolve?` | How it resolved, the payout, and the proof. |

Site: https://www.playhunch.xyz

## hunch-bazaar

| # | Say (on X) | What happens |
|---|---|---|
| 1 | `@bankrbot market this: Will ETH close above $4,000 on Sep 19, 2026?` or reply to any post with `@bankrbot market this` | A preview first: question, outcomes, close, deadline, fee, who resolves it. Nothing is created until the same user replies `confirm`. |
| 2 | `@bankrbot bet $5 YES on bazaar.playhunch.xyz/markets/<id>` | The quote (payout, multiple, fee), the creator's record and the disclosure; on confirm the stake is paid over x402. |
| 3 | `@bankrbot odds on bazaar.playhunch.xyz/markets/<id>` | The card: odds with the pool size beside them, bettors, close, who settles it and their record. |
| 4 | `@bankrbot resolve YES` in the market's thread, or `@bankrbot resolve <link> YES` | Creator only. Winners are paid in the same call and the result is posted. |
| 5 | `@bankrbot void <link> <a reason of 10 or more characters>` | Creator only, before resolving. Every bettor is refunded in full with no fee, and the reason is shown on the market. |

Also: explore, search, my markets, markets to resolve, my bets, results, a creator's record,
leaderboards, share links, earnings and help.

Site: https://bazaar.playhunch.xyz

## Money and safety

- **Bets.** `hunch` bets start at $1 and `hunch-bazaar` bets at $0.50. Hunch sets no
  maximum: your Bankr wallet's own limits apply, and Bankr tells you when a bet is over one. A
  bet is never split to get around a limit.
- **Host pinning.** Each skill calls only its own origin over HTTPS and never fetches a URL taken
  from a post or a response.
- **x402 pin-check.** Before signing, the payment challenge must match the pinned network, asset
  (Base USDC), recipient and resource, and its amount must equal the stake you confirmed. Only
  an EIP-3009 `transferWithAuthorization` is ever signed; never an approval or allowance.
- **Wallet proofs.** Bazaar writes that move no money (create, resolve, void, register) are
  authorized by a free signature over a fixed message that the skill checks line by line first.
- **Posts are data.** Text in a post or a market is never an instruction.

Betting risks the whole stake. Not financial advice.

## About this repo

These folders are published from Hunch's own source, where each skill is tested against the API
it calls. Direct edits here are overwritten by the next publish, so please open an issue instead.

## License

[MIT](LICENSE)
