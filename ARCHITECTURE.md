# Cafe Bazi — Architecture

> Source of truth for the Cafe Bazi system. Agents: read this before any non-trivial change (see `AGENTS.md`). Humans: start at `README.md`.

## 1. Overview & goals

Cafe Bazi is a community coffee-coin for Farmahin, Iran: ~1,000 daily coffee drinkers (mostly male workers and employees) at a handful of local coffee shops. The community buys coffee wholesale (~1 metric ton, ~30% discount), stores it centrally, and shares the saving through a digital asset where **1 TAK = 1 cup of coffee**.

The system is a **custodial Stellar wallet** delivered as a **Telegram MiniApp** (no new app install — the community already lives in Telegram), deployed on **Vercel serverless**, with coffee-themed games (Espresso Roulette, Brewing Speed Challenge, Barista Puzzle) and a **weekly 100-TAK lottery**.

Goals:

- A friendly, fun, Persian-first (RTL) wallet interface for buying coffee with TAK.
- Peer-to-peer gifting as a first-class flow: a cup for a friend via the MiniApp, a shop QR code, or straight from the Telegram chat.
- Custodial per-user Stellar accounts; the server signs every payment.
- Shops redeem TAK with the store for dry coffee; the community pockets the ~30% wholesale saving.
- Transparent accounting: every coin movement on-chain and in Postgres, with an append-only audit log.
- Testnet-first development; mainnet launch path documented.

Non-goals (for now): fiat payment gateway, SMS/carrier-based payments, non-Telegram clients, self-custody, multi-currency.

## 2. Constraints

| Constraint | Implication |
|---|---|
| Vercel serverless | Stateless handlers, cold starts, no long-lived processes. Neon HTTP driver, Drizzle over HTTP, cron via `vercel.json` |
| Telegram MiniApp | `initData` is the identity layer; no new app install; bot configuration required |
| Stellar | Custodial accounts; XLM base reserves; Horizon as the network interface; testnet-first |
| ~1,000 users | ~1,000 custodial accounts; XLM reserves must be budgeted; batch-friendly operations |
| Custodial model | Server holds private keys encrypted at rest; all signing server-side |
| Node runtime | `@stellar/stellar-sdk@16.2.0` requires **Node >= 22** — pin Node 22 on Vercel and locally |

## 3. Context diagram

```text
                         ┌───────────────────────────────┐
                         │          Telegram            │
                         │  MiniApp (Bot, no install)   │
                         │  Bot chats (pay-by-message)  │
                         └───────┬───────────────┬───────┘
                                 │ initData      │ Bot webhook updates
                                 │ (HMAC-valid.) │ (TELEGRAM_BOT_TOKEN)
                                 ▼               ▼
        ┌───────────────────────────────────────────────────────────┐
        │                   Next.js app (Vercel)                   │
        │  tRPC router (typed API for the MiniApp)  ·  plain        │
        │  handlers (auth/tma, bot/webhook, cron/lottery, health)   │
        │  service layer (server-only)                              │
        └───────┬────────────────────────────────────┬─────────────┘
                │ Drizzle (HTTP)                      │ Stellar SDK 16.2.0
                ▼                                     ▼
   ┌────────────────────────┐            ┌──────────────────────────┐
   │     Neon Postgres      │            │  Stellar network         │
   │  users, transactions,  │            │  Horizon                 │
   │  contacts, lottery,    │            │  ISSUER / FUNDING /      │
   │  inventory…            │            │  LOTTERY_POOL + per-     │
   └────────────────────────┘            │  user + per-shop accts   │
                                         └──────────────────────────┘
```

## 4. Tech stack & version rationale

| Package | Version | Why / notes |
|---|---|---|
| `next` | 16.3.0 | App Router; serverless-friendly; React 19 |
| `react` | 19 | Peer of Next 16 |
| `@stellar/stellar-sdk` | 16.2.0 | ESM-first, bundles `@noble/ed25519` + `bignumber.js`; **requires Node >= 22** |
| `@tma.js/init-data-node` | 2.0.8 | Server-side initData validation. Successor of the deprecated `@telegram-apps/init-data-node` — do not use the deprecated package |
| `@telegram-apps/sdk-react` | 3.3.9 | MiniApp client SDK (peer React 17/18/19) |
| `@neondatabase/serverless` | 1.1.0 | HTTP driver for Neon; no persistent connections on serverless |
| `drizzle-orm` | 0.44+ | Typed schema, migrations, transaction support for money flows |
| `@trpc/server` + `@trpc/client` + `@trpc/react-query` | 11.x | End-to-end typed API; every internal endpoint is a tRPC procedure mounted at `/api/trpc` |
| `zod` | latest | Input schemas for every procedure; shared validation in the service layer |
| `superjson` | latest | tRPC data transformer — required so `bigint` money survives serialization |
| `@tanstack/react-query` | 5.x | Client data layer: caching, refetch, optimistic updates for tRPC calls |
| `next-intl` | latest | Persian-first RTL; `fa` default, `en` fallback |
| `vitest` | latest | Unit + integration tests |
| Playwright | latest | e2e tests |

Runtime: **Node 22** everywhere — `"engines": { "node": ">=22" }` in `package.json` and Node 22 on Vercel. Next.js alone would run on Node 20.9+, but the Stellar SDK needs 22; do not downgrade.

## 5. Account & asset model

### 5.1 Accounts (Stellar)

| Account | Owned by | Purpose |
|---|---|---|
| `ISSUER` | Community treasury | Issues/burns `TAK`; receives shop redemptions (burn) |
| `FUNDING` | Operators | Funds new custodial accounts: base reserve (~2 XLM/account incl. trustline) + ops |
| `LOTTERY_POOL` | Community treasury | Holds the weekly prize float; pays 100 TAK per draw |
| Per-member account | Server (custodial) | One per member; created at onboarding |
| Per-shop account | Server (custodial) | One per merchant; receives cup payments |

**Custody:** the server generates each account's keypair, funds it via `FUNDING`, adds the `TAK` trustline, encrypts the secret with AES-256-GCM under `KEY_ENCRYPTION_KEY`, and stores only the ciphertext + public key. All signing happens server-side; users never see private keys.

**XLM reserves:** each custodial account costs ~2 XLM (account entry + trustline), subject to Stellar network fee changes. Budget ~2,000 XLM to fund ~1,000 member accounts. This is a documented business cost.

### 5.2 Asset

- Code `TAK`; issuer = community treasury (`ISSUER`). No decimals. The code comes from Persian *tak* (تک, "single") — café slang for a single espresso shot.
- **1 TAK = 1 cup of espresso** at any participating shop.
- Supply control: mint on fiat top-up (admin), burn on redemption (shops → treasury). No arbitrary issuance.
- On-chain balance is the source of truth; `balances` in Postgres is a denormalized cache.

## 6. Data model (Drizzle, `src/db/schema.ts`)

Money columns are `numeric` (no decimals); the TS side is `bigint`. Enums are checked at the app layer (or Postgres enums).

| Table | Key columns | Notes / indexes |
|---|---|---|
| `users` | `id`, `telegram_id`, `telegram_username`, `first_name`, `phone` (nullable, opt-in via Telegram `requestContact`), `role` (`member\|merchant\|admin`), timestamps | `UNIQUE (telegram_id)` |
| `stellar_accounts` | `id`, `user_id`, `public_key`, `encrypted_secret`, `status` | `UNIQUE (public_key)`; `FK user_id` |
| `coffee_shops` | `id`, `merchant_id`, `slug`, `name`, `address`, `is_active` | `FK merchant_id`; `UNIQUE (slug)` — the short public id encoded in QR `start_param` payloads (`s3` → `slug = '3'`) |
| `transactions` | `id`, `tx_hash`, `type` (`purchase\|p2p\|gift\|mint\|burn\|redemption\|lottery`), `status` (`pending\|submitted\|confirmed\|failed`), `amount` (numeric), `from_account`, `to_account`, `memo`, `user_id`, `shop_id`, timestamps | `UNIQUE (tx_hash)` — idempotency key; `idx (user_id, created_at)` |
| `balances` | `id`, `user_id`, `shop_id` (nullable), `amount` (numeric), `updated_at` | Denormalized cache; `UNIQUE (user_id)` and `UNIQUE (shop_id)` |
| `contacts` | `id`, `user_id`, `contact_user_id`, `source` (`username\|transfer\|phone`), `nickname`, `last_used_at` | Lazily built from successful sends + username searches (the community directory is `users` itself); `UNIQUE (user_id, contact_user_id)`; `idx (user_id, last_used_at)` |
| `game_sessions` | `id`, `user_id`, `game`, `nonce`, `hmac`, `expires_at`, `status` | HMAC-signed; `idx (user_id, game, created_at)` for rate limits |
| `game_scores` | `id`, `user_id`, `game_session_id`, `score`, `submitted_at` | Server-verified; `FK game_session_id` |
| `lottery_entries` | `id`, `draw_id`, `user_id`, `tickets`, `created_at` | `UNIQUE (draw_id, user_id)` |
| `lottery_draws` | `id`, `week`, `status` (`scheduled\|drawn\|paid`), `winner_user_id`, `ledger_hash`, `prize` (100), `drawn_at` | `UNIQUE (week)` — idempotency + overlap lock |
| `inventory` | `id`, `item`, `quantity_grams`, `updated_at` | Central bean stock |
| `redemptions` | `id`, `shop_id`, `amount_tak`, `beans_grams`, `status`, `admin_id`, `created_at` | Shop coins → beans |
| `audit_log` | `id`, `actor_user_id`, `action`, `entity`, `entity_id`, `metadata` (jsonb), `created_at` | Append-only; every mint/burn/redemption/admin action. `metadata` records structured intent context (e.g. `{action, cups, shop, table, source}`) — the future AI/LLM grounding dataset (§16.3.4) |

## 7. Key flows

### 7.1 Onboarding

```text
Client (MiniApp)      Next.js (/api/auth/tma)      Neon          Stellar
      │ initData + user      │                        │              │
      │─────────────────────>│ validate HMAC          │              │
      │                      │ (@tma.js/init-data-node)              │
      │                      │ upsert user            │─────────────>│
      │                      │ generate keypair       │              │
      │                      │ fund from FUNDING +    │              │
      │                      │ add TAK trustline      │─────────────>│
      │                      │ AES-256-GCM encrypt    │              │
      │                      │ store ciphertext       │─────────────>│
      │  JWT httpOnly cookie │                        │              │
      │<─────────────────────│                        │              │
```

Steps: verify initData → upsert `users` → create keypair → fund via `FUNDING` + trustline → encrypt & store secret in `stellar_accounts` → set JWT cookie.

### 7.2 Coffee purchase (incl. QR fast-pay)

```text
Client            tRPC payments.create           Neon                  Stellar
   │ pick shop + cups   │                          │                      │
   │ (QR prefill)       │                          │                      │
   │───────────────────>│ build+sign member→shop    │                      │
   │                    │ insert tx (pending)      │─────────────────────>│
   │                    │ submit to Horizon        │─────────────────────>│
   │                    │ update tx (submitted)    │─────────────────────>│
   │  brewing animation │ confirm → (confirmed)    │                      │
   │<───────────────────│                          │                      │
```

Steps: choose shop/cups (optionally pre-filled from a scanned QR, below) → server builds & signs a `member → shop` TAK payment → submit to Horizon → insert a `transactions` row with unique `tx_hash` → confirm → client shows the "brewing" animation while pending.

**QR fast-pay:** each shop — and optionally each table — displays a static QR card encoding `https://t.me/<bot>?startapp=<payload>` (e.g. `s3` for shop 3, `s3t2` for shop 3 table 2; `start_param` is capped at 64 chars). The numeric id maps to `coffee_shops.slug` (`UNIQUE`). The customer scans it with the Telegram or OS camera (scanning happens *outside* the MiniApp — WebView camera access is unreliable); Telegram opens the bot and launches the MiniApp with `start_param` in `initDataUnsafe`. The app pre-selects the shop/table so the customer only taps the cup count and confirm. The server validates the payload against `coffee_shops` (`is_active`) before pre-filling; short-lived HMAC-signed one-time pay tokens (nonce + expiry, like game sessions in §7.6) are reserved for future table billing.

### 7.3 Shop redemption

```text
Shop/Admin       admin.redemptions.create            Neon            Stellar
   │ send coins (TAK)     │                             │                 │
   │─────────────────────>│ shop → ISSUER payment       │────────────────>│
   │                      │ burn TAK                    │────────────────>│
   │                      │ record redemptions row      │───────────────>│
   │                      │ decrement inventory         │───────────────>│
   │                      │ audit_log entry             │───────────────>│
   │  beans dispatched     │                             │                 │
   │<─────────────────────│                             │                 │
```

The shop transfers TAK to the treasury (`ISSUER`), which burns the coins; the admin records bean dispatch and decrements `inventory`.

### 7.4 Top-up (fiat)

Admin-triggered mint/transfer: the `admin.coins.mint` procedure mints TAK from `ISSUER` to a member account after an off-chain fiat payment. The fiat gateway is out of scope; the procedure and audit trail are documented.

### 7.5 Weekly lottery (cron)

```text
Vercel Cron            /api/cron/lottery              Neon          Stellar
   │  (CRON_SECRET + sig)  │                             │               │
   │──────────────────────>│ idempotency: unique week +   │               │
   │                       │ advisory lock; skip if done │──────────────>│
   │                       │ snapshot eligible entries   │──────────────>│
   │                       │ latest ledger hash          │──────────────>│
   │                       │ CSPRNG pick winner          │               │
   │                       │ LOTTERY_POOL → winner       │               │
   │                       │ (100 TAK)                   │──────────────>│
   │                       │ mark draw paid              │──────────────>│
```

Steps: eligibility snapshot → fair draw (CSPRNG seeded by the latest Stellar ledger hash) → payout 100 TAK from `LOTTERY_POOL` → record. Idempotent: `lottery_draws.week` unique + Postgres advisory lock, because cron retries/overlaps are possible.

### 7.6 Games

Request session (`games.session`) → server issues an HMAC-signed session (game, nonce, TTL) → client plays (Espresso Roulette, Brewing Speed Challenge, Barista Puzzle) → submit score + nonce (`games.score`) → server verifies session validity, per-user rate limits, and score bounds → award tickets/coins.

### 7.7 Mint/burn + audit

All supply changes go through `admin.*` procedures and are written to `audit_log` (actor, action, entity, metadata). Nothing mutates supply outside these paths.

### 7.8 Peer-to-peer gifting (MiniApp)

```text
Client (MiniApp)      tRPC payments.send            Neon             Stellar
   │ pick recipient      │                            │                 │
   │ (search/recents)    │                            │                 │
   │────────────────────>│ resolve recipient          │                 │
   │                     │ (username/contacts table)  │                 │
   │                     │ build+sign member→member   │                 │
   │                     │ insert tx (pending)        │────────────────>│
   │                     │ submit to Horizon          │────────────────>│
   │  cup flies across   │ confirm → (confirmed)      │                 │
   │<────────────────────│                            │                 │
```

Steps: pick a recipient — username search (Telegram usernames are globally unique) or the lazily-built `contacts` table — → server resolves the recipient in `users` (must be onboarded) → builds & signs a `member → member` TAK payment → the exact lifecycle, idempotency, and reconciliation of §7.2 → the recipient sees the incoming cup with its `memo` in `wallet.get`. P2P payments are rate-limited and capped per user (see §10); the `memo` is a first-class fun surface (rotating Persian café-phrase presets + free text).

### 7.9 Chat payments (pay-by-message)

```text
Telegram chat             /api/bot/webhook           Neon             Stellar
   │ forward / command      │                            │                 │
   │───────────────────────>│ validate webhook secret    │                 │
   │                        │ parse forward_from/mention │                 │
   │                        │ resolve recipient (users)  │                 │
   │  [☕ بده | 🎁 | نه]     │                            │                 │
   │<───────────────────────│                            │                 │
   │  tap confirm           │                            │                 │
   │───────────────────────>│ build+sign member→member   │────────────────>│
   │                        │ (shared payments.send svc) │                 │
   │  "bought you a cup ☕"  │                            │                 │
   │<───────────────────────│                            │                 │
```

Three entry points, all handled by the same webhook → service path:

- **Forward-to-pay:** the user forwards a friend's message into the bot DM; the update carries `forward_from` (original sender `telegram_id`) → the bot replies with an inline confirm keyboard ("☕ ۱ قهوه بده / 🎁 ۲ تا بده / نه"). Forwarding *into the bot's own DM* always reaches the bot regardless of privacy mode.
- **Reply-to-pay:** the user replies "1☕" to a forwarded message or an earlier payment card; the bot reads `reply_to_message.forward_from`.
- **Command-style:** `/coffee @username 2` (or a bare `@username ☕`) parsed in the bot DM.

Steps: verify the update (request signature against `TELEGRAM_BOT_TOKEN`; `update_id` dedup) → parse sender (`from`) and intended recipient (`forward_from`, replied-to user, or mentioned username) → resolve the recipient in `users` (must be onboarded) → reply with an inline confirm keyboard showing **recipient name + amount** (fat-finger / misattribution guard) → on tap, run the same `payments.send` service path (build, sign, submit, confirm) → notify both sender and recipient ("x bought you a cup ☕"). Idempotency via `transactions.tx_hash`; per-user rate limits and daily caps apply as in the MiniApp flow.

**Implementation notes (Phases 1–3):** the webhook uses Telegram **secret-token mode** (`X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_BOT_TOKEN`). Confirm keyboard `callback_data` encodes `{recipient telegram_id, amount, memo-preset index, nonce}` as compact base64url JSON. Chat-initiated payments store `memo = "pay:<nonce>"` so a double-tap on the same confirm button short-circuits deterministically (query by `user_id` + memo) in addition to the unique `tx_hash` insert; `payments.send` returns a `duplicate` flag and the bot answers "already handled" instead of double-notifying. Sender/recipient notifications are posted into the payment chat with an `@username` mention — no per-user `chat_id` is stored in Phases 1–3 (a `users.telegram_chat_id` column is a later-hardening option for true DM delivery).

**Future seam (§16):** keep the pipeline as *receive → normalize → intent → execute* with a clean boundary between **intent extraction** and **payment execution**. A later LLM layer may replace only the extract stage (natural-language pay-by-message); execute — recipient resolution, confirm keyboard, `payments.send` — stays deterministic.

## 8. API reference (tRPC procedures + plain Route Handlers)

The internal API is a **tRPC router** (`src/server/trpc/root.ts`) mounted at `/api/trpc`. Client calls are type-inferred from `AppRouter`, so the tables below are the server-side contract. Every procedure is input-validated with a Zod schema and guarded by `protectedProcedure` (JWT session) or `adminProcedure` (JWT + `role = admin`); see §10.

### 8.1 tRPC procedures

| Procedure | Type | Auth | Purpose |
|---|---|---|---|
| `wallet.get` | query | JWT | Balance + transaction history |
| `wallet.sync` | mutation | JWT | Refresh the cached `balances` row from the on-chain TAK balance (picks up external send/receive from standard Stellar wallets) |
| `payments.create` | mutation | JWT (member) | Create coffee payment (build, sign, submit) |
| `payments.status(id)` | query | JWT | Payment status |
| `payments.send` | mutation | JWT (member) | Peer-to-peer TAK payment: resolve recipient (username/contacts), build, sign, submit |
| `payments.recipients` | query | JWT | Recipient picker: `contacts` recents + username search over `users` |
| `shops.listActive` | query | JWT | List active shops for the member payment flow (QR prefill fallback) |
| `games.session` | mutation | JWT | Request HMAC-signed game session |
| `games.score` | mutation | JWT + session | Submit score for verification |
| `lottery.enter` | mutation | JWT (member) | Enter weekly lottery |
| `lottery.status` | query | JWT | Draw status + entries |
| `admin.coins.mint` / `admin.coins.burn` / `admin.coins.topUp` | mutation | admin | Mint / burn / top-up |
| `admin.redemptions.create` | mutation | admin | Record shop redemption + bean dispatch |
| `admin.shops.list` / `admin.shops.create` / `admin.shops.update` | query/mutation | admin | Manage coffee shops |
| `admin.inventory.get` / `admin.inventory.set` | query/mutation | admin | Manage bean inventory |

### 8.2 Plain Route Handlers (external entry points)

Called by parties outside the MiniApp client (Telegram webview, Telegram Bot API, Vercel Cron, probes) — these stay as Route Handlers under `src/app/api`:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/tma` | initData | Verify initData; upsert user; create/fund account; issue JWT |
| POST | `/api/bot/webhook` | `TELEGRAM_BOT_TOKEN` (update signature) | Telegram update handler: forward-to-pay, reply-to-pay, command-style payments (§7.9) |
| GET | `/api/health` | public | Liveness probe |
| POST | `/api/cron/lottery` | `CRON_SECRET` + cron signature | Weekly lottery draw — **built in Phase 4** (roadmap), reserved here |

**Planned exception:** `/api/llm/chat` — a streaming chat Route Handler reserved for the deferred AI/LLM phase (§16). tRPC has no durable streaming transport on serverless (no WebSockets), so this plain handler is designed in by exception; it is **not built until Phase 7**. Do not hack streaming through tRPC.

## 9. Directory structure (planned)

```text
cafe-bazi/
├─ src/
│  ├─ app/
│  │  ├─ api/
│  │  │  ├─ trpc/[trpc]/route.ts   # tRPC HTTP handler (fetch adapter, §8)
│  │  │  ├─ auth/tma/route.ts      # plain handler: initData → JWT cookie (§8.2)
│  │  │  ├─ bot/webhook/route.ts   # plain handler: Telegram updates → chat payments (§7.9, §8.2)
│  │  │  ├─ cron/lottery/route.ts  # plain handler: weekly draw (§8.2)
│  │  │  └─ health/route.ts        # public liveness probe (§8.2)
│  │  └─ [locale]/                 # i18n pages; fa default, RTL
│  ├─ components/        # UI components (tRPC React Query hooks)
│  ├─ db/
│  │  ├─ schema.ts       # Drizzle schema (§6)
│  │  └─ index.ts        # client (server-only)
│  ├─ server/trpc/       # tRPC router: root.ts, context.ts, middleware.ts
│  ├─ services/          # service layer: stellar, payments (purchase + P2P + chat), lottery, games
│  ├─ lib/               # auth, crypto, validation, utils
│  └─ i18n/              # next-intl messages
├─ drizzle/              # generated migrations
├─ vercel.json           # Node 22 runtime, cron
├─ package.json          # engines: node >= 22
└─ README.md · AGENTS.md · ARCHITECTURE.md
```

## 10. Security model

- **Auth:** initData HMAC-validated server-side with `@tma.js/init-data-node` using `TELEGRAM_BOT_TOKEN`; never trust client-side `window.Telegram.WebApp.initData` alone. Session = signed JWT in an httpOnly cookie, resolved once into the tRPC context; `protectedProcedure` / `adminProcedure` middleware enforce membership and `role = admin` on every procedure. Plain handlers (§8.2) re-check the cookie or `CRON_SECRET` directly.
- **Custody:** private keys encrypted with AES-256-GCM; master key in `KEY_ENCRYPTION_KEY` (Vercel env, never committed). No private material in client bundles.
- **Idempotency:** payment code relies on the DB unique `transactions.tx_hash` and the status machine `pending → submitted → confirmed | failed`; a reconciliation job resolves stuck `submitted` rows against Horizon.
- **Isolation:** Stellar and DB modules are `server-only`; route handlers stay light.
- **Anti-cheat:** HMAC-signed game sessions with TTL, per-user rate limits, server-side score bounds, nonce reuse rejection.
- **P2P & chat payments:** recipient resolution is server-side only (`telegram_username`, `telegram_id`, `forward_from`) — never trust a client-supplied recipient ID; the bot webhook validates the update signature against `TELEGRAM_BOT_TOKEN` on every request; chat payments require an inline confirm keyboard showing recipient + amount before signing; per-user send caps and rate limits (incl. new-account limits); `phone` is stored only after explicit one-time `requestContact` consent.
- **AI/LLM boundary (future, §16):** LLM-extracted intents are *proposals only* — re-validated by Zod schemas and the confirm-before-pay keyboard before any money movement; prompt inputs are sanitized/redacted before any provider call; the LLM never selects Stellar accounts or executes payments.
- **Secrets:** no secrets in client bundles; `*.env*` gitignored.

## 11. Failure modes & reconciliation

| Failure | Mitigation |
|---|---|
| Horizon outage | Outbox-style retry for `submitted` txs; status polling; alerting |
| Cron retry / overlap | `lottery_draws.week` unique + Postgres advisory lock; draw is idempotent |
| Double-spend race | Unique constraints on `tx_hash`; on-chain balance check before building a payment; single writer per account (applies to purchases and P2P) |
| Duplicate / retried Telegram updates | `update_id` dedup + `tx_hash` idempotency on chat payments; confirm-before-pay keyboard |
| Misattributed forward | Server-side recipient resolution; show recipient preview + confirm keyboard before paying |
| Cold starts | Light tRPC procedures and route handlers; Neon HTTP driver pools connections; lazy Stellar SDK imports |
| Lost funding/issuer keys | Keys in Vercel env + documented backup procedure; `FUNDING`/`ISSUER` secrets never in code |
| Stuck payments | Reconciliation job: `submitted` → poll Horizon → `confirmed` or `failed` |

## 12. Deployment (Vercel)

- Runtime: Node 22 — `"engines": { "node": ">=22" }` in `package.json`; Node 22 configured on Vercel.
- Cron: `vercel.json` `"crons"` → `/api/cron/lottery`, weekly (e.g. `0 12 * * 1` UTC). The route is guarded by `CRON_SECRET` (Bearer check) plus the `x-vercel-cron` header/signature pattern.
- Bot webhook: after every deploy, register `POST ${NEXT_PUBLIC_APP_URL}/api/bot/webhook` via Telegram `setWebhook` (webhook, not long-polling — serverless). Telegram signs every update; the handler validates the secret from `TELEGRAM_BOT_TOKEN`.
- Networks: default `testnet` for dev/CI (Friendbot + `FUNDING`); switch to mainnet via `STELLAR_NETWORK=mainnet` + `HORIZON_URL`. Preview deployments always testnet.
- Top-up/withdraw funds go through admin APIs; fiat gateway out of scope.

### Env vars (Vercel)

| Var | Scope | Description |
|---|---|---|
| `DATABASE_URL` | server | Neon Postgres connection string |
| `TELEGRAM_BOT_TOKEN` | server | Bot token for initData HMAC validation + webhook secret-token mode |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | both | Public bot username (no `@`) for QR `startapp` deep links |
| `KEY_ENCRYPTION_KEY` | server | AES-256-GCM master key for Stellar secrets |
| `STELLAR_NETWORK` | server | `testnet` (default) or `mainnet` |
| `HORIZON_URL` | server | Horizon endpoint for the active network |
| `TAK_ISSUER_PUBLIC_KEY` | server | TAK issuer public key (from `scripts/setup-testnet.ts`) |
| `CRON_SECRET` | server | Bearer secret guarding `/api/cron/lottery` |
| `JWT_SECRET` | server | JWT signing secret for the MiniApp session cookie (httpOnly) |
| `NEXT_PUBLIC_APP_URL` | both | Public base URL of the app |

## 13. Observability

- Sentry for errors (server + client) with release tracking.
- Vercel Analytics for traffic and performance.
- Structured logs for payments, lottery draws, and audit actions.
- Alerts: Horizon submit failures, reconciliation drift, cron failures, bot webhook failures.

## 14. Testing strategy

- **Unit (vitest):** initData HMAC validation, AES-256-GCM encrypt/decrypt round-trip, integer/bigint money math, game score verification, lottery draw determinism given a seed, tRPC context/middleware behavior, Zod input rejection per procedure, QR `start_param` parsing, bot webhook command parsing and `forward_from` attribution.
- **Integration:** against Stellar testnet (Friendbot-funded): onboarding, coffee purchase (incl. QR prefill), P2P `payments.send`, chat payment via webhook, redemption, mint/burn. Drizzle against a Neon test branch.
- **e2e (Playwright):** MiniApp flows in the browser — login, wallet read, buy coffee (mocked Horizon), send a cup to a contact, games, lottery entry; RTL layout checks.

## 15. Open questions & roadmap

Open questions:

- XLM reserve budget and who funds it (community treasury).
- Fiat top-up gateway (out of scope for v1).
- Legal/compliance posture for custodial wallets in Iran.
- Treasury governance for `ISSUER` / `LOTTERY_POOL` keys.
- Phone-number friend matching via one-time `requestContact` (opt-in `users.phone`) — include in v1 or defer to a later phase?
- LLM provider selection (Persian capability, pricing, Iran access/compliance) — deliberately deferred to Phase 7 (§16).

Roadmap (phases mirrored in `README.md`):

1. Foundation: scaffold, auth, DB, key custody, wallet read.
2. Payments + P2P: buy coffee (incl. QR fast-pay), `payments.send`, `contacts`, tx status, reconciliation.
3. Chat payments: `/api/bot/webhook`, forward-to-pay, reply-to-pay, command-style flows.
4. Games + lottery.
5. Merchant/store: shops, redemptions, inventory.
6. Mainnet launch hardening.
7. **AI/LLM (deferred)** — natural-language chat payments, coffee knowledge, and fun/personality features (coffee fortunes, weekly recaps, gift-memo generation, post-game roasts). Catalogued in §16 but deliberately not scheduled until the deterministic core is proven on mainnet.

## 16. AI / LLM strategy (deferred)

### 16.1 Policy

LLM features are **deliberately deferred to Phase 7** (post-mainnet). The system stays 100% deterministic until then. Rationale:

- The core value prop is deterministic (payments, custody, lottery, audit) — an LLM layer adds cost, latency, cold-start pressure on serverless, and security surface with no v1 benefit.
- The strongest LLM use cases are **data-hungry** (personalized narratives, recaps, fortunes): they only become good after real transaction / memo / game / lottery history accumulates. Deferral is a prerequisite, not just cost avoidance.
- Persian-model quality, pricing, and provider availability (incl. the Iran access/compliance question in §15) are moving targets; integrating later against a mature landscape is cheaper.

This section documents (a) the future use-case catalog and (b) the **design seams** that must be preserved so Phase 7 is a bolt-on, not a rewrite.

### 16.2 Future use-case catalog (Phase 7, not committed)

| Category | Candidate features | Notes |
|---|---|---|
| FAQ / support | Grounded FAQ assistant (bot DM + MiniApp); onboarding concierge; payment-status explainer; error-message humanizer; merchant concierge | RAG over this document + FAQ corpus; semantic cache; hybrid template + LLM for error messages |
| Coffee information | Coffee knowledge chat (Persian-first); weekly batch storytelling from `inventory`; treasury transparency explainer; personalized recommendations | Ground in real data; deterministic math (dose ratios, stock forecasts) with LLM narrative only |
| Fun & amusement | Coffee fortune (فال قهوه — Persian coffee-ground reading, seeded by real activity); barista persona chat; gift-memo surprise generator; post-game roasts + weekly game report; daily trivia/quiz awarding lottery tickets; lottery narration; weekly personal recap | Per-user daily caps; cron-batched generation; quiz answers validated deterministically server-side |
| Agentic | Ask-by-message (natural-language chat payments, §7.9); gift story for the recipient; community newsletter; voice orders (Whisper transcription); anomaly/social-engineering guard | LLM extracts intent only — the money path stays deterministic (§16.3.1) |

**Flagship candidates:** ask-by-message (payments without commands, behind the existing confirm keyboard) and the coffee fortune (a culturally native, cost-capped daily ritual).

### 16.3 Readiness decisions (design seams — preserve from v1)

1. **Intent/execute boundary in the webhook (§7.9):** pipeline is *receive → normalize → intent → execute*; only the intent-extraction stage may later be LLM-powered (slot-filling, intent classification). Execute stays deterministic. The confirm-before-pay keyboard is the *only* gate between intent and money.
2. **tRPC procedures = future tool registry:** keep procedures small, single-purpose, canonically named (verb + noun), with strict Zod schemas. A future LLM agent calls them as tools; never make a procedure that reads *and* moves money.
3. **Streaming route reservation (§8.2):** `/api/llm/chat` is a planned plain-handler exception for streaming chat on serverless (tRPC has no durable WebSockets). Not built until Phase 7; do not hack streaming through tRPC.
4. **`audit_log.metadata` habit (§6, §7.7):** record structured intent context with every action (e.g. `{action, cups, shop, table, source}`). This append-only log is the future grounding dataset for narratives, recaps, and treasury explanations.
5. **Data-driven bot replies:** canned bot text lives in i18n messages / data, not string literals scattered in handlers — so a later LLM can render the text layer without touching logic.
6. **Privacy posture:** store structured events + intents, **never raw chat transcripts**; redact before any future provider call; send the minimum data to the model. Extends the §10 discipline to the LLM era.
7. **Observability baseline:** correlate logs by `user_id` + request `trace_id` on payment and webhook paths — the baseline for future LLM latency/token-cost measurement.

### 16.4 Non-goals (explicitly out until Phase 7)

- No `ai_*` tables (`ai_sessions`, `ai_cache`, `ai_usage`), prompt library, LLM gateway, or provider abstraction service.
- No chat transcript storage.
- No RAG infrastructure (a repo markdown FAQ serves humans and a future LLM equally at this stage).
- No event bus / message queue "for future AI".
