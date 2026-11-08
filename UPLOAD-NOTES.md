# Bankr Meme Engine: what changed and how to upload

These files replace the app on Bankr (slug `bankr-meme-engine`). Upload `index.html`, `manifest.json` and
`scripts/manageRotator.ts`. `routeRotatorClick.ts` and `syncDailySnapshot.ts` are unchanged.

## Do these first (in this order)

1. **Rotate the Telegram bot token.** The old token was hard-coded in `manageRotator.ts` and shipped with the
   app, so treat it as public. In @BotFather: `/mybots` → the bot → API Token → **Revoke current token**.
2. **Add the new token as a secret:** app secrets → `TELEGRAM_BOT_TOKEN` = the new token. Telegram drops fail
   with a clear error until it's set.
3. Upload the files.
4. **Run the identity check once.** Signed in as a wallet that is *not* the owner, call
   `manageRotator` with `{ "action": "whoami" }` and read `sessionCaller`:
   - It's that wallet: good. Bankr passes the real visitor, and nobody can act as another wallet.
   - It's the owner wallet: Bankr runs every visitor as the owner. Then also do step 5.
5. *(Optional, required if step 4 showed the owner.)* Lock admin with a passphrase:
   app secrets → `ADMIN_KEY` = a long random passphrase. Central Admin tab → paste it in the
   🔐 box → **Save** → **Turn lock on**. After that, admin actions need the key. The key is saved only
   in your own browser. Turn the lock off again with `{ "action": "disableAdminKey" }`.

## Security fixes (manageRotator.ts)

| Problem | Fix |
|---|---|
| **Anyone could become admin.** `isAdmin` trusted a wallet passed in the call, and the owner wallet is public (it's in every `?ref` link). Passing `user: <owner>` unlocked offers, queue, free placements and Telegram broadcasts. | Admin now comes only from the Bankr session (`ctx.caller`), never from a wallet in the call. Optional `ADMIN_KEY` lock on top. |
| **Act as another wallet.** Every action used `safeArgs.user` first, so anyone could save links, bid or confirm payments as someone else, for example overwrite a promoter's affiliate links with their own. | When the session is a real non-owner viewer, that session wins over any wallet in the call. |
| **Hard-coded Telegram bot token**, and the call could also supply its own token. | Read only from the `TELEGRAM_BOT_TOKEN` secret. |
| **Free "paid" spots.** `activateBetaTester` and `claimFree24hTrial` activated a spot with no payment, and anyone could call them. The page doesn't use them. | Admin-only. |
| **Pick your own price.** `confirmPaymentAndActivate` used the `amountUsd` the caller sent. | The price comes from config (`betaTesterPriceUsd`, `agentUpgradePriceUsd`, default $1 / $10). Only admins can record a custom amount. |
| **Reusable or fake tx hashes.** Any string activated a spot, again and again. | It must be a real-looking Base hash (`0x` + 64 hex), and each hash activates one spot only. |
| **`getState` leaked everything** to every visitor: all wallets' affiliate links, who referred whom, every payment, every launch-alert Telegram handle. | Visitors get the shared catalog plus their own slice (and their referrer's links, which the page needs). Admins still get everything. |

### Still open: payments aren't checked on-chain

A well-formed hash is still not proof that USDC was paid. The SDK has `bankr.chain.getLogs` (USDC `Transfer`
logs to the owner wallet), but there's no documented way to fetch one transaction or the current block. So I
didn't guess at it and risk breaking real payments. Until that's added, check the Central Admin payments
table against Basescan. Next step: test whether `getLogs` accepts a recent block range, then verify
`from = payer`, `to = owner`, `value >= price` for the given hash.

## Onboarding (index.html)

One self-contained block just before `</body>`, between the `ONBOARDING (self-contained)` comments. Delete
the block and the onboarding is gone. It doesn't edit any existing function. It wraps `renderUI()` (so it
reads the same `getState` result), `switchTab()` and `copyUniversalReferralLink()`, and calls the existing
`handleActivateBetaTester()`, `bankr.auth.requireSignIn()` and `loadRotatorState()`.

- **First visit:** a fork. *I want traffic for my project* (the $1 / 24h starter spot → the 11:50 AM ET
  auction → paste your link → the existing USDC checkout) or *I want to promote & earn* (connect wallet → your
  slug → Link Management → copy your Universal Referral Link).
- **Getting started checklist** (bottom right, collapsible): connect wallet & slug · save 1 affiliate link
  (+50) · launch alerts (+100) · $1 spot or share your link. Ticks come from live state. The engine's
  auto-saved self-link doesn't count as "saved a link". The card retires itself when all four are done.
- **Hints:** `?` next to the cutoff timer, the points pill and the auction capacity stat.
- **🚀 Guide** pill in the header reopens everything.
- **Not shown again** to returning users, anyone with real activity, or anyone who ticked "Don't show this
  again". Stored in `localStorage` (`bme_onb_v1`), with a memory fallback if the iframe blocks storage.
- **Copy rules:** $1 is called the beta price, there's no promised traffic or earnings, and points are
  described as not tokens.

## Also worth a look (not changed)

- **The "LIVE PULSE" ticker shows made-up events** (`MOCK_TICKER_EVENTS`: fake wallets "signing up",
  "$1 spots claimed") next to a "live" label. Either feed it from real `state.payments` / `customerReferralLogs`,
  or label it as an example.
- **Two `?ref` formats** reach users: `getMasterUserLink()` sometimes uses the full wallet, sometimes the
  8-character slug. Both resolve to the same promoter, but one format would be cleaner.
- `registerIntroPlacement` is called by the page but doesn't exist in `manageRotator.ts`.
