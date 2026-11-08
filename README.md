# The Bankr Meme Engine

A [Bankr](https://bankr.bot) app (slug `bankr-meme-engine`, unlisted) that runs a promotional traffic
rotator, a daily affiliate-spot auction that closes at 11:50 AM Eastern, and per-promoter link and
earnings tracking — all settled in USDC on Base.

The app ships as three files plus three scripts. There is no build step and no dependencies: `index.html`
is one self-contained page, and the scripts are uploaded to Bankr exactly as they sit in `scripts/`.

## Repo layout

| Path | What it is |
|---|---|
| `index.html` | The whole frontend: one self-contained page (markup, CSS, and all logic inline) that talks to the scripts through the Bankr SDK. |
| `manifest.json` | App definition — slug, version, permissions, secrets, the scheduled cron entry, and the `daily_offers` data schema. |
| `scripts/manageRotator.ts` | The main server-side script. All admin, payment, bidding, and promoter-link actions. |
| `scripts/routeRotatorClick.ts` | Public, unauthenticated click router. Decides where a visitor lands and records the click. |
| `scripts/syncDailySnapshot.ts` | Cron job (every 5 minutes). Settles the daily auction and publishes the public `daily_offers` snapshot. |
| `UPLOAD-NOTES.md` | The change notes from the most recent release: setup order, security fixes, and known gaps. |

## How traffic is routed

`routeRotatorClick` is the only public script. It reads the `daily_offers` snapshot and picks a
destination based on who the visitor arrived as:

- **Human referral** (`?ref=<slug-or-wallet>`, no `agentId`) — the visitor is sent straight to the
  referring promoter's own saved link for the selected offer, so their affiliate code is what gets
  credited. Rounds through the offer list using `pointer`.
- **Agent referral** (`?agentId=...`) — treated as part of the rotator pool, and counted as attributed.
- **No referral** — round-robin across a master pool and the individual offer pool, split by
  `masterTrafficPercent` (default 70/30). Master placements are interleaved across every offer feed,
  with the winner's own saved links substituted into the destination.

Any incoming `ref` or `agentId` is appended to the final URL (unless it is already present), so
attribution survives the redirect.
- **Empty snapshot** — falls back to the Jobless Joe app rather than failing.

The router refuses to spend anything it doesn't have to: the manifest caps it at zero HTTP calls, zero
chain reads, 3 s execution, 4 KB of return data, and per-viewer/per-app rate limits.

## The daily cycle

1. Bids are collected through the **Daily Spot Auction** tab (`placeBid`).
2. At **11:50 AM ET** the cycle locks. `syncDailySnapshot` (cron `*/5 * * * *`) sees
   `lastSettledCycle !== cycleId` and settles: master bids are ranked by bid size and the top
   `masterSpotLimit` winners become 24-hour placements, the rest are released, and any lingering
   individual bids are cancelled.
3. Each winning bid splits **25% referral commission / 50% treasury / 25% staking**, with the referral
   share going to the promoter or agent who referred the bidder, if any.
4. The script rewrites `daily_offers` — the public snapshot of active placements, the promoter map, and
   the countdown — which is what the router reads on every click.

Promoters hold a stake in the outcome too: saving affiliate links, subscribing to launch alerts, and
claiming spots all earn **Beta Activity Points** (see the *Beta Points & Token Launch* tab), which are
explicitly described in-app as not tokens.

## Scripts in detail

### `manageRotator.ts`

The single entry point for everything stateful. `action` defaults to `getState`.

| Group | Actions |
|---|---|
| Read | `getState`, `whoami` |
| Admin lock | `enableAdminKey`, `disableAdminKey` |
| Payments | `preparePayment`, `confirmPaymentAndActivate`, `activateBetaTester`, `updateBetaTesterConfig` |
| Promoter links | `saveAffiliateLink`, `saveOfferLinks` |
| Auction | `placeBid`, `cancelBid` |
| Config | `updateSpotConfig`, `updateTelegramConfig` |
| Alerts & media | `subscribeLaunchAlert`, `setAdminPhoneMedia` |
| Content & broadcast | `generateFreshMeme`, `broadcastTelegramDrop` |
| Catalog | `addOffer`, `updateOffer`, `removeOffer` |
| Queue | `manualActivatePlacement`, `removeQueueItem`, `extendQueueItem` |
| Maintenance | `purgeMockPromoter` |

Two behaviours worth knowing before you change anything:

- **Admin comes from the Bankr session, never from the arguments.** `isAdmin` is derived from
  `ctx.caller` matching the owner/author wallet, and a wallet that arrives as a typed-in argument can
  never grant admin — the owner wallet is public, it appears in every `?ref` link. An optional
  `ADMIN_KEY` passphrase can be layered on top.
- **`getState` is scoped per visitor.** Only admins receive the full state. Everyone else gets the
  shared catalog plus their own slice and their referrer's links, which is all the page needs to rewrite
  offer buttons.

### `routeRotatorClick.ts`

Public and stateless apart from the click counters it increments on `daily_offers`. Returns the
`destinationUrl`, the `selectedOffer`, and an `attribution` block that records whether the click was
attributed, to whom, and whether a promoter's saved offer link was used.

### `syncDailySnapshot.ts`

Runs on the manifest's cron. Responsible for auction settlement, dropping expired placements from the
queue, rebuilding the promoter map, and publishing version 5 of `daily_offers`.

## Manifest facts

- **Permissions:** `read:appdata`, `write:appdata`, `fetch:http`, `read:secrets`, `read:wallet`,
  `read:portfolio`, `read:chain`, `prepare:transaction`.
- **Secrets:** `TELEGRAM_BOT_TOKEN` (broadcast drops), `PLUNDER_AND_RIFFLE_API_KEY` (live creative
  generation), `ADMIN_KEY` (optional admin passphrase). None are required; all are `scope: author` and
  never exposed to the public script.
- **Public data keys:** `daily_offers`, `admin_phone_media`.
- **`frontendIdentity: owner`** — note this is why the identity check in the upload notes matters.
- **Allowed hosts:** the secrets declare `bot.plunderandriffle.com` and `api.telegram.org`.

## How to upload

Bankr apps are deployed by uploading files to the app, not by building from this repo.

1. **Rotate the Telegram bot token first.** An older token was hard-coded in `manageRotator.ts` and
   shipped with the app, so treat it as public: @BotFather → `/mybots` → your bot → API Token →
   *Revoke current token*. Then set the new value as the `TELEGRAM_BOT_TOKEN` app secret. Telegram drops
   fail with a clear error until it is set.
2. **Upload** `index.html`, `manifest.json`, and `scripts/manageRotator.ts`. (`routeRotatorClick.ts` and
   `syncDailySnapshot.ts` only need uploading when they change.)
3. **Run the identity check once.** Signed in as a wallet that is *not* the owner, call `manageRotator`
   with `{ "action": "whoami" }` and read `sessionCaller`:
   - It is that wallet — Bankr passes the real visitor and nobody can act as another wallet. Done.
   - It is the owner wallet — Bankr runs every visitor as the owner. Set `ADMIN_KEY` to a long random
     passphrase as an app secret, open **Central Admin**, paste it in the 🔐 box, save, and **turn the
     lock on**. The lock can be released again with `{ "action": "disableAdminKey" }`.
4. **Confirm the cron is active** — `syncDailySnapshot` on `*/5 * * * *`. Without it the auction never
   settles and `daily_offers` goes stale.

`UPLOAD-NOTES.md` has the full detail for the current release, including what changed in each security
fix.

## Known gaps

- **Payments are not verified on-chain yet.** `confirmPaymentAndActivate` requires a well-formed Base
  transaction hash (`0x` + 64 hex) that has not been used before, but a well-formed hash is not proof
  that USDC was actually paid. Until the transfer is checked, reconcile the Central Admin payments table
  against Basescan.
- **The "LIVE PULSE" ticker is illustrative.** It renders `MOCK_TICKER_EVENTS` under a "live" label.
  Either feed it from real `state.payments` / `customerReferralLogs` or label it as an example.
- **Two `?ref` formats reach users.** `getMasterUserLink()` sometimes emits the full wallet and
  sometimes the 8-character slug. Both resolve to the same promoter; one format would be cleaner.
- **`registerIntroPlacement` is called by the page but does not exist** in `manageRotator.ts`.

## Working in this repo

```bash
git log --oneline          # this repo starts at the standalone import of the app
```

It is a plain Git repository with no toolchain — open `index.html` in a browser only for static markup
inspection; the page needs the Bankr SDK and an app session to do anything real. `.gitignore` covers
local `node_modules/`, build output, and `.env` files; keep secrets in Bankr app secrets, never in the
repo.
