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
| Stellar | Custodial accounts; XLM base reserves; TAK is a SEP-41 Soroban token contract — payments/balances via Soroban RPC, Horizon for classic ops; testnet-first |
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
| `@stellar/stellar-sdk` | 16.2.0 | ESM-first, bundles `@noble/ed25519` + `bignumber.js` + the Soroban RPC client and SEP-41 token contract support; **requires Node >= 22** |
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
| `FUNDING` | Operators | Funds new custodial accounts (base reserve + Soroban fee float) + ops |
| `LOTTERY_POOL` | Community treasury | Holds the weekly prize float; pays 100 TAK per draw |
| `GAME_POOL` | Community treasury | Holds the games prize float; pays Espresso Roulette rewards (and refunds) |
| Per-member account | Server (custodial) | One per member; created at onboarding |
| Per-shop account | Server (custodial) | One per merchant; receives cup payments |

**Custody:** the server generates each account's keypair, funds it via `FUNDING`, encrypts the secret with AES-256-GCM under `KEY_ENCRYPTION_KEY`, and stores only the ciphertext + public key. All signing happens server-side; users never see private keys.

**XLM reserves:** each custodial account needs the base reserve (~1 XLM) plus a small Soroban fee float (resource fees are burned per contract call); no trustlines are required because TAK is a SEP-41 Soroban token contract. Budget ~2,000 XLM to fund ~1,000 member accounts. This is a documented business cost.

### 5.3 Identity: Telegram users, web users, and linked wallets

`users.telegram_id` stays NOT NULL + UNIQUE as the identity key. Web-only visitors who sign in with Stellar Web Authentication (SEP-10) reuse the existing placeholder pattern from admin-created users: `telegramId = "web-" + crypto.randomUUID()`. Username/password users get `telegramId = "password-" + crypto.randomUUID()`. Neither can be addressed via the bot/chat paths (no numeric Telegram id), which is correct.

Usernames are a **shared community-handle namespace**: the chosen username lives in `users.telegram_username` (the same column Telegram handles use) and is enforced case-insensitively by a unique expression index (`users_telegram_username_lower_unique`, `UNIQUE (lower(telegram_username))` — Postgres ignores NULLs, so Telegram-only users without a handle are unaffected). Password usernames are stored lowercase; lookups (`getUserByUsername`) compare `lower(telegram_username)` so bot `/coffee @handle` and recipient search resolve Telegram and password users identically. Password users can receive bot `/coffee` payments by username but not via `forward_from`/reply flows (no numeric `telegram_id`).

An optional **linked wallet** (`wallet_links`) is a user's own external Stellar address. It serves as:

1. **Identity** — a linked public key is how `resolveStellarLogin` maps a SEP-10 login back to an existing account, and it is the proof-of-ownership anchor for the whole web auth flow.
2. **Withdrawal/fallback destination** — when a recipient has no custodial account, P2P gifts are paid to their linked wallet directly (their own keys, no cached-balance credit). The linked wallet is **never** the payment source: custody and signing remain server-side.

Linking requires SEP-10 proof of ownership, and a wallet can be linked to only one user (`UNIQUE (wallet_links.public_key)`), which also prevents "log in as someone else" via a second pre-existing link.

### 5.2 Asset

- TAK is a **SEP-41 Soroban token contract** identified by `TAK_CONTRACT_ID` — not a classic trustline asset. Payments are SEP-41 `transfer(from, to, i128)` contract invocations submitted via Soroban RPC; balances are read from the contract's `("Balance", address)` data key. The classic trustline path (code `TAK`, issuer = community treasury `ISSUER`) is a fallback used only when `TAK_CONTRACT_ID` is unset.
- On-chain amounts are `i128` scaled by `decimals = 7` (`TAK_DECIMALS = 10^7`); the app layer keeps **whole TAK as `bigint`** — no app-layer decimals anywhere. The scaling constant lives in `src/services/stellar.ts`; `src/services/wallet.ts` serializes `bigint` → `numeric` for Postgres via `takToNumeric`.
- No trustlines; no on-chain memos (memos are stored in `transactions.memo` only).
- **1 TAK = 1 cup of espresso** at any participating shop. The code comes from Persian *tak* (تک, "single") — café slang for a single espresso shot.
- Supply control: mint on fiat top-up (admin), burn on redemption (shops → treasury). No arbitrary issuance.
- On-chain balance is the source of truth; `balances` in Postgres is a denormalized cache.

## 6. Data model (Drizzle, `src/db/schema.ts`)

Money columns are `numeric` (no decimals); the TS side is `bigint`. Enums are checked at the app layer (or Postgres enums).

| Table | Key columns | Notes / indexes |
|---|---|---|
| `users` | `id`, `telegram_id`, `telegram_username`, `first_name`, `phone` (nullable, opt-in via Telegram `requestContact`), `role` (`member\|merchant\|admin`), timestamps | `UNIQUE (telegram_id)`; `UNIQUE (lower(telegram_username))` — shared Telegram + password handle namespace (§5.3) |
| `stellar_accounts` | `id`, `user_id`, `public_key`, `encrypted_secret`, `status` | `UNIQUE (public_key)`; `FK user_id` |
| `coffee_shops` | `id`, `merchant_id`, `slug`, `name`, `address`, `is_active` | `FK merchant_id`; `UNIQUE (slug)` — the short public id encoded in QR `start_param` payloads (`s3` → `slug = '3'`) |
| `transactions` | `id`, `tx_hash`, `type` (`purchase\|p2p\|gift\|mint\|burn\|redemption\|withdrawal\|lottery`), `status` (`pending\|submitted\|confirmed\|failed`), `amount` (numeric), `from_account`, `to_account`, `memo`, `user_id`, `shop_id`, timestamps | `UNIQUE (tx_hash)` — idempotency key; `idx (user_id, created_at)` |
| `balances` | `id`, `user_id`, `shop_id` (nullable), `amount` (numeric), `updated_at` | Denormalized cache; `UNIQUE (user_id)` and `UNIQUE (shop_id)` |
| `contacts` | `id`, `user_id`, `contact_user_id`, `source` (`username\|transfer\|phone`), `nickname`, `last_used_at` | Lazily built from successful sends + username searches (the community directory is `users` itself); `UNIQUE (user_id, contact_user_id)`; `idx (user_id, last_used_at)` |
| `game_sessions` | `id`, `user_id`, `game`, `nonce`, `hmac`, `expires_at`, `status` | HMAC-signed; `idx (user_id, game, created_at)` for rate limits |
| `game_scores` | `id`, `user_id`, `game_session_id`, `score`, `submitted_at` | Server-verified; `FK game_session_id` |
| `lottery_entries` | `id`, `draw_id`, `user_id`, `tickets`, `created_at` | `UNIQUE (draw_id, user_id)` |
| `lottery_draws` | `id`, `week`, `status` (`scheduled\|drawn\|paid`), `winner_user_id`, `ledger_hash`, `prize` (100), `drawn_at` | `UNIQUE (week)` — idempotency + overlap lock |
| `inventory` | `id`, `item`, `quantity_grams`, `updated_at` | Central bean stock |
| `redemptions` | `id`, `shop_id`, `amount_tak`, `beans_grams`, `status`, `admin_id`, `created_at` | Shop coins → beans |
| `wallet_links` | `id`, `user_id`, `public_key`, `source` (`stellar`), `label` (nullable), `verified_at`, `created_at` | User's own external Stellar wallets; `UNIQUE (public_key)` (identity mapping, one wallet = one user); `idx (user_id)` |
| `auth_challenges` | `id`, `public_key`, `nonce` (uint64 memo), `purpose` (`login\|link`), `status` (`pending\|used\|expired`), `expires_at`, `created_at` | SEP-10 challenges; `UNIQUE (nonce)` (single-use), `idx (status)`, `idx (public_key)` |
| `auth_credentials` | `id`, `user_id`, `username` (lowercase), `password_hash` (scrypt), `failed_attempts`, `locked_until` (nullable), `password_changed_at`, timestamps | Username/password sign-in (§7.12); `UNIQUE (user_id)` (one credential set per user), `UNIQUE (username)` |
| `telegram_codes` | `id`, `user_id`, `code_hash` (hex SHA-256 — never plaintext), `attempts`, `status` (`pending\|used\|expired`), `expires_at`, `consumed_at`, `created_at` | Telegram code sign-in (§7.13); one active `pending` code per user — a new request expires the previous one; `idx (user_id, status)`, `idx (user_id, created_at)` |
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
│                      │ fund from FUNDING      │─────────────>│
│                      │ AES-256-GCM encrypt    │              │
│                      │ store ciphertext       │─────────────>│
│  JWT httpOnly cookie │                        │              │
│<─────────────────────│                        │              │
```

Steps: verify initData → upsert `users` → create keypair → fund via `FUNDING` → encrypt & store secret in `stellar_accounts` → set JWT cookie.

### 7.2 Coffee purchase (incl. QR fast-pay)

```text
Client            tRPC payments.create           Neon                  Stellar
   │ pick shop + cups   │                          │                      │
   │ (QR prefill)       │                          │                      │
   │───────────────────>│ build+sign member→shop    │                      │
   │                    │ insert tx (pending)      │─────────────────────>│
   │                    │ submit to Soroban RPC    │─────────────────────>│
   │                    │ update tx (submitted)    │─────────────────────>│
   │  brewing animation │ confirm → (confirmed)    │                      │
   │<───────────────────│                          │                      │
```

Steps: choose shop/cups (optionally pre-filled from a scanned QR, below) → server builds & signs a `member → shop` SEP-41 `transfer` (simulate → assemble → submit via Soroban RPC) → insert a `transactions` row with unique `tx_hash` → confirm → client shows the "brewing" animation while pending.

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

**Espresso Roulette (implemented, Phase 4).** A prize wheel in the MiniApp where members win real TAK from `GAME_POOL`. **1 free spin/day** (`FREE_SPINS_PER_DAY`) plus **paid spins at 1 TAK each** (`PAID_SPIN_COST`), capped at 10/day (`PAID_SPINS_PER_DAY`). Wheel slots, weights, and caps are constants in `src/services/games.ts` (admin tuning is a later phase; no DB-backed config).

```text
Client (MiniApp)      tRPC games.session/spin        Neon             Stellar
   │ mount              │                                │                 │
   │────────────────────>│ issue HMAC session (10 min)    │                 │
   │<────────────────────│ {sessionId, nonce, hmac, caps} │                 │
   │  tap spin           │                                │                 │
   │────────────────────>│ verify+consume session (1×)    │                 │
   │                     │ if paid: cap check + balance   │                 │
   │                     │ build+sign member→GAME_POOL    │────────────────>│
   │                     │ insert game_entry (pending)    │                 │
   │                     │ submit → confirmed             │────────────────>│
   │                     │ CSPRNG weighted draw           │                 │
   │                     │ if win: build+sign POOL→member │────────────────>│
   │                     │ insert game_reward, submit      │                 │
   │                     │ game_scores + audit_log        │                 │
   │  wheel animates to  │                                │                 │
   │  server-chosen slot │                                │                 │
   │<────────────────────│ {outcome, caps, balance, txs}  │                 │
```

Flow details:

- **Anti-cheat:** the outcome is drawn server-side with `node:crypto` `randomInt` over cumulative weights. The client only animates to the server-chosen slot; a one-time HMAC session (`game_sessions`, TTL 10 min, single-use `active → used`) authenticates each spin. Rejection codes: `SESSION_INVALID` / `SESSION_EXPIRED` / `SESSION_USED`.
- **Caps:** `createGameSession` rejects with `RATE_LIMIT` only when both caps are exhausted; free spins are capped at spin time by the daily session count, paid spins by the daily `game_entry` count. Free spins remaining = daily sessions minus paid entries, so a paid spin never consumes the free spin.
- **Transfers:** both the entry fee (`transactions.type = "game_entry"`, member → `GAME_POOL`) and any reward (`type = "game_reward"`, `GAME_POOL` → member) reuse the idempotent `transactions.tx_hash` unique + `pending → submitted → confirmed | failed` machine, serialized per user by `withAccountLock`. On-chain amounts are whole TAK; the cached `balances` row is updated only on confirmed transfers.
- **Prize-failure handling:** if the reward transfer fails, the service attempts one automatic refund (`GAME_POOL` → member, 1 TAK) for paid spins. If the refund also fails (or a free-spin reward fails, where there is no fee to refund), an `audit_log` entry with `metadata: { needsRefund: true }` is written for the reconciliation job, and the spin throws `POOL_UNAVAILABLE`.
- **UX:** the wheel is procedural SVG (8 slots, palette fills, gold jackpot), rotated with a CSS ease-out transition; `@telegram-apps/sdk-react` haptics and CSS confetti on wins. No image assets or new packages.

Brewing Speed Challenge and Barista Puzzle remain roadmap items; their schema tables are reserved.

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
   │                     │ submit to Soroban RPC      │────────────────>│
   │  cup flies across   │ confirm → (confirmed)      │                 │
   │<────────────────────│                            │                 │
```

Steps: pick a recipient — username search (Telegram usernames are globally unique) or the lazily-built `contacts` table — → server resolves the recipient in `users` (must be onboarded) → builds & signs a `member → member` SEP-41 `transfer` → the exact lifecycle, idempotency, and reconciliation of §7.2 → the recipient sees the incoming cup with its `memo` in `wallet.get`. P2P payments are rate-limited and capped per user (see §10); the `memo` is a first-class fun surface (rotating Persian café-phrase presets + free text) — stored in `transactions.memo` only, since Soroban transactions do not support on-chain memos.

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

### 7.10 Admin console (user management)

Admin-only page at `/admin` (`src/app/[locale]/admin/page.tsx`), backed by the `admin.users.*` tRPC procedures (§8.1) and a `session.role` query that drives the admin nav link. Every procedure runs behind `adminProcedure` (JWT + `role = admin` re-resolved from the DB on every request), and the page re-checks the session server-side before rendering (§10).

- **List** (`admin.users.list`): returns users with name, `@username`, Stellar account address (`stellar_accounts.public_key`; `null` when the user has no account), and the cached `balances.amount`. On-chain is the source of truth; a per-user **sync from chain** (`admin.users.syncBalance` → `syncBalanceFromChain`) refreshes the cached row. The list reads cached rows only — no N×1 on-chain reads across the whole table. Search filters by `firstName` / `telegramUsername` (ILIKE); pagination is `offset`/`limit`.
- **Add** (`admin.users.create`): inserts a `users` row, creates a custodial Stellar account via `ensureStellarAccount` (keypair + testnet funding; `pending_funding` on funding failure/mainnet until Phase 6), and ensures a zero `balances` row. `telegramId` is optional at create — when omitted the service stores a `manual-<uuid>` placeholder, so the user cannot sign in via Telegram but can hold/receive TAK.
- **Edit** (`admin.users.update`): changes `firstName`, `telegramUsername`, `phone` (nullable to clear), and `role`. `telegramId` is immutable (set only at create). Guard rails: an admin cannot demote themselves, and the last remaining admin cannot be demoted.

### 7.11 Web sign-in (SEP-10 / Freighter + Albedo) and linked wallets

```text
Browser (Freighter / Albedo)   /api/auth/stellar/*        Neon             Stellar
   │ getPublicKey                  │                        │                 │
   │───────────────────────>       │ issue challenge         │                 │
   │ challenge XDR                 │  (buildChallengeTx +    │                 │
   │<───────────────────────       │   memo nonce, 5 min TTL)│───────────────>│
   │ sign challenge                │                        │                 │
   │───────────────────────>       │ verify (single-use,     │                 │
   │  (from client)                │  readChallengeTx +      │                 │
   │                               │  verifyChallengeTxSigners)               │
   │                               │ consume challenge row   │───────────────>│
   │                               │ resolveStellarLogin     │                │
   │  JWT httpOnly cookie          │  (wallet_links → user)  │                │
   │<───────────────────────       │                        │                 │
```

Steps: the client asks the connected wallet for access (`getWalletProviders()` in `src/lib/wallet-providers.ts` exposes **Freighter** — desktop browser extension — and **Albedo** — browser popup intent that works on phones too; Lobstr is deferred) and reads the active public key → `POST /api/auth/stellar/challenge` returns a SEP-10 challenge XDR (built for that public key, memo = uint64 nonce, `web_auth_domain` = app hostname) plus the server-known `networkPassphrase` → the wallet signs the challenge (Freighter `signTransaction`, Albedo `tx` intent with a passphrase→network map) → `POST /api/auth/stellar/verify` re-derives the identity from the challenge's **source account** (never a client-supplied address), verifies the signature, atomically marks the challenge `used`, and resolves the user: existing `wallet_links` row → that user, else a new web user (`telegramId = web-<uuid>`, short-form `GABC…XYZ` name) with the wallet linked and a zero `balances` row → JWT cookie.

Web-only users get their **custodial account lazily**: `executePayment` calls `ensureStellarAccount` + `retryAccountFunding` on first in-app spend (buy, send, withdrawal). No XLM is spent at sign-in. If the account can't be funded (e.g. mainnet), the payment fails with `ACCOUNT_NOT_READY` and the UI surfaces a retry CTA.

Wallet popups and browser extensions do not work inside the Telegram WebView, so the client hides provider buttons in a real MiniApp and falls back to Telegram auth, with an **open-in-browser** path (`openLink` from `@telegram-apps/sdk-react`) on the wallets page for external wallet management in the phone's browser. The dev mock (non-TMA browser) keeps showing both provider buttons (`isBrowserContext()`/`getWalletProviders()` in `src/lib/wallet-providers.ts`).

**Linking a wallet** (authenticated, via tRPC `wallets.link*`) runs the same challenge/verify flow with `purpose: "link"`, then inserts the `wallet_links` row. Unlink is blocked when it would strip a web-only user of their last sign-in method. Sending to a web-only recipient with a verified linked wallet pays the linked address directly (external bookkeeping: no cached-balance credit, no contact row); recipients with neither get `RECIPIENT_NOT_ACTIVE` before any transaction is built.

### 7.12 Username/password sign-up and sign-in

```text
Browser (outside Telegram)   /api/auth/password/*       Neon            Stellar
   │ username + password          │                       │                │
   │ signup ─────────────────────>│ normalize + validate  │                │
   │                              │ scrypt hash           │                │
   │                              │ insert users          │───────────────>│
   │                              │ (telegramId=password-<uuid>,            │
   │                              │  handle=lower(username))                │
   │                              │ insert auth_credentials│               │
   │                              │ insert balances (0)   │               │
   │                              │ eager custodial acct  │───────────────>│
   │                              │ audit_log auth.signup │               │
   │  JWT httpOnly cookie         │                       │                │
   │<─────────────────────────────│                       │                │
   │ signin ─────────────────────>│ lookup lower(username)│                │
   │                              │ verify scrypt,        │                │
   │                              │ lockout on 5 fails    │                │
   │  JWT httpOnly cookie         │                       │                │
   │<─────────────────────────────│                       │                │
```

Steps (sign-up): validate/normalize the username (`/^[a-z0-9_]{5,32}$/`, lowercase) → enforce the password policy (min 8, max 128) → hash with scrypt (per-user 16-byte salt, `N=16384 r=8 p=1`, stored `scrypt$N$r$p$salt$hash`) → insert a `users` row with the `password-<uuid>` placeholder identity and the username as the public handle → insert the `auth_credentials` row → insert a zero `balances` row → create/fund the custodial Stellar account **eagerly** (`ensureStellarAccount`, exactly like the TMA route) so the user can buy/send immediately → write an `audit_log` `auth.signup` entry → set the JWT cookie. Any duplicate-key error (the `auth_credentials.username` unique or the `users` lowercase-handle index colliding with a Telegram user) is caught and reported as `USERNAME_TAKEN` — never a pre-check, because a race between check and insert is possible.

Steps (sign-in): look up `auth_credentials` by the normalized username (unknown username returns the same generic `INVALID_CREDENTIALS` as a wrong password — no user enumeration) → refuse while `locked_until > now` → verify the password with a timing-safe compare → on failure increment `failed_attempts`; on the 5th failure set `locked_until = now + 15 min` and reset the counter → on success reset the counter and load the `users` row → set the JWT cookie. The response mirrors `/api/auth/tma` (`{ ok, user, accountStatus }`) so the client can show the existing `pending_funding` notice.

The client shows this form in the guest branch only outside Telegram (`!insideTelegram`), alongside the SEP-10 wallet login with an "or" divider (`src/components/password-auth.tsx` + `onboarding-gate.tsx`).

### 7.13 Telegram code sign-in (passwordless web login)

```text
Browser (outside Telegram)   /api/auth/telegram-code/*    Bot + Neon
   │ username ───────────────> resolve username → users   │
   │                          (numeric telegram_id only)  │
   │                          rate limit (3/15 min, 60s)  │
   │                          store sha256(code), 10 min  │
   │                          send code via bot DM ──────>│
   │ <── code arrives ───────                             │
   │ username + code ────────> timing-safe compare,       │
   │                          single-use, 5 attempts max  │
   │  JWT httpOnly cookie     audit auth.code_verified   │
   │<─────────────────────────                            │
```

Steps: the user enters a username that belongs to a Telegram-linked account (numeric `telegram_id` — TMA users and admin-created users with a numeric id) → `requestTelegramCode` resolves the user, applies per-user rate limits (≤3 codes / 15 min, 60 s resend cooldown), invalidates any previous `pending` code, stores `sha256(code)` with a 10-minute TTL, and DMs the 6-digit code via the bot → `verifyTelegramCode` compares timing-safe with ≤5 attempts per code and marks the code single-use on success, and the route issues the same JWT session as password sign-in. A Telegram API "can't initiate conversation" failure maps to `BOT_NOT_STARTED` — the user must open the bot and press Start (the bot answers `/start` with a welcome). The signup route reports `codeLoginAvailable` when the entered username collides with a Telegram-addressable account, so the client offers this flow instead of the `USERNAME_TAKEN` dead end (§7.12).

## 8. API reference (tRPC procedures + plain Route Handlers)

The internal API is a **tRPC router** (`src/server/trpc/root.ts`) mounted at `/api/trpc`. Client calls are type-inferred from `AppRouter`, so the tables below are the server-side contract. Every procedure is input-validated with a Zod schema and guarded by `protectedProcedure` (JWT session) or `adminProcedure` (JWT + `role = admin`); see §10.

### 8.1 tRPC procedures

| Procedure | Type | Auth | Purpose |
|---|---|---|---|
| `wallet.get` | query | JWT | Balance + transaction history |
| `wallet.sync` | mutation | JWT | Refresh the cached `balances` row from the on-chain TAK balance (picks up external send/receive from standard Stellar wallets) |
| `wallets.list` | query | JWT | Linked external wallets (address, source, verified date) + the TAK contract id for display |
| `wallets.linkStart` | mutation | JWT | Issue a SEP-10 challenge with `purpose: "link"` for the given public key |
| `wallets.linkVerify` | mutation | JWT | Verify the signed link challenge and attach the wallet to the session user |
| `wallets.unlink` | mutation | JWT | Remove a linked wallet (blocked for a web-only user's last sign-in method) |
| `payments.create` | mutation | JWT (member) | Create coffee payment (build, sign, submit) |
| `payments.status(id)` | query | JWT | Payment status |
| `payments.send` | mutation | JWT (member) | Peer-to-peer TAK payment: resolve recipient (username/contacts), build, sign, submit |
| `payments.sendExternal` | mutation | JWT (member) | Send TAK to an external Stellar address (ed25519 `G…` only; app-user destinations credit their cached balance) |
| `payments.recipients` | query | JWT | Recipient picker: `contacts` recents + username search over `users` |
| `shops.listActive` | query | JWT | List active shops for the member payment flow (QR prefill fallback) |
| `session.role` | query | JWT | Current user's role (drives the admin nav link) |
| `session.logout` | mutation | JWT | Clear the `cb_session` cookie (web sign-out) |
| `admin.users.list` | query | admin | List users with name, Stellar address, and cached TAK balance; search + pagination (§7.10) |
| `admin.users.create` | mutation | admin | Add a user (row + custodial Stellar account + zero `balances` row) (§7.10) |
| `admin.users.update` | mutation | admin | Edit user (`firstName`, `telegramUsername`, `phone`, `role`; `telegramId` immutable) (§7.10) |
| `admin.users.syncBalance` | mutation | admin | Refresh one user's cached balance from the on-chain TAK balance (§7.10) |
| `games.session` | mutation | JWT | Issue an HMAC-signed one-time game session + remaining spin counters |
| `games.spin` | mutation | JWT + session | Verify/consume the session, enforce caps, draw the outcome server-side, move fees/rewards (`game_entry`/`game_reward`), record score + audit |
| `lottery.enter` | mutation | JWT (member) | Enter weekly lottery |
| `lottery.status` | query | JWT | Draw status + entries |
| `admin.coins.mint` / `admin.coins.burn` / `admin.coins.topUp` | mutation | admin | Mint / burn / top-up |
| `admin.redemptions.create` | mutation | admin | Record shop redemption + bean dispatch |
| `admin.shops.list` / `admin.shops.create` / `admin.shops.update` | query/mutation | admin | Manage coffee shops |
| `admin.inventory.get` / `admin.inventory.set` | query/mutation | admin | Manage bean inventory |

`admin.users.*` and `session.role` are the first implemented `admin.*` procedures (see §7.10); `admin.coins.*`, `admin.shops.*`, and `admin.inventory.*` remain roadmap work.

### 8.2 Plain Route Handlers (external entry points)

Called by parties outside the MiniApp client (Telegram webview, Telegram Bot API, Vercel Cron, probes) — these stay as Route Handlers under `src/app/api`:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/tma` | initData | Verify initData; upsert user; create/fund account; issue JWT |
| POST | `/api/auth/stellar/challenge` | public | Issue a SEP-10 login challenge (`{ publicKey, purpose: "login" }`); returns XDR + `networkPassphrase` (§7.11) |
| POST | `/api/auth/stellar/verify` | public | Verify a signed login challenge; resolve/create the user; issue JWT (§7.11) |
| POST | `/api/auth/password/signup` | public | Username/password sign-up: validate, hash, create user + credential + zero balance + eager custodial account; issue JWT (§7.12) |
| POST | `/api/auth/password/signin` | public | Username/password sign-in: verify credential with per-username lockout; issue JWT (§7.12) |
| POST | `/api/auth/telegram-code/request` | public | Request a one-time Telegram code for a Telegram-linked username (per-user rate-limited; `BOT_NOT_STARTED` → 409) (§7.13) |
| POST | `/api/auth/telegram-code/verify` | public | Verify the code (timing-safe, ≤5 attempts) and issue JWT (§7.13) |
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
│  │  │  ├─ auth/stellar/          # plain handlers: SEP-10 login challenge/verify (§7.11, §8.2)
│  │  │  ├─ auth/password/         # plain handlers: username/password signup/signin (§7.12, §8.2)
│  │  │  ├─ bot/webhook/route.ts   # plain handler: Telegram updates → chat payments (§7.9, §8.2)
│  │  │  ├─ cron/lottery/route.ts  # plain handler: weekly draw (§8.2)
│  │  │  └─ health/route.ts        # public liveness probe (§8.2)
│  │  └─ [locale]/                 # i18n pages; fa default, RTL
│  │     ├─ admin/page.tsx         # admin console: user management (§7.10)
│  │     ├─ buy/page.tsx           # coffee purchase (§7.2)
│  │     ├─ send/page.tsx          # P2P gifting (§7.8)
│  │     ├─ wallets/page.tsx       # linked external wallets (§7.11)
│  │     └─ qr/[shopSlug]/page.tsx # shop/table QR card (§7.2)
│  ├─ components/        # UI components (tRPC React Query hooks); components/admin/ = admin console (§7.10)
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

- **Auth:** initData HMAC-validated server-side with `@tma.js/init-data-node` using `TELEGRAM_BOT_TOKEN`; never trust client-side `window.Telegram.WebApp.initData` alone. **SEP-10 (web) auth** uses the SDK's `WebAuth` helpers: the identity is the challenge's **source account** read from the signed transaction (`readChallengeTx`) — never a client-supplied address in the verify body — and signatures are checked against that address with `verifyChallengeTxSigners`. Challenges are **single-use** (uint64 memo nonce + `auth_challenges` row consumed by a guarded `pending → used` update), have a 5-minute TTL, and are rate-limited (≤10 pending/hour per public key). Challenges and wallet links are rejected for the SEP-10 server key and any custodial `stellar_accounts` address. Linking a wallet requires the same signed-challenge proof of ownership; `wallet_links.public_key` is UNIQUE so one wallet maps to one user. A web-only user cannot unlink their last wallet (their only sign-in method). **Username/password auth** hashes with scrypt (per-user random 16-byte salt, `N=16384 r=8 p=1`, stored as `scrypt$N$r$p$salt$hash`; timing-safe compare on verify), enforces a per-username brute-force lockout (5 failed attempts → 15 minutes), and returns a single generic `INVALID_CREDENTIALS` for both unknown usernames and wrong passwords to prevent user enumeration. Duplicate usernames are rejected by DB unique constraints (catch-and-return), not a pre-check. Password users get their custodial account eagerly at signup (unlike lazy web users) so they can pay immediately. Session = signed JWT in an httpOnly cookie, resolved once into the tRPC context; `protectedProcedure` / `adminProcedure` middleware enforce membership and `role = admin` on every procedure. Plain handlers (§8.2) re-check the cookie or `CRON_SECRET` directly.
- **Telegram code auth:** the one-time code is the credential — a passwordless replacement for Telegram-linked accounts. Only SHA-256 hashes of codes are stored (never plaintext, never returned or logged); verification is timing-safe with a ≤5-attempt cap per code and a per-user send rate limit (3 codes / 15 min, 60 s resend cooldown). Codes are single-use with a 10-minute TTL; a new request invalidates the previous pending code. Recipient resolution is server-side only (username → numeric `telegram_id`); session issuance is identical to password sign-in. A user who has not started the bot gets `BOT_NOT_STARTED` instead of silently retrying.
- **Custody:** private keys encrypted with AES-256-GCM; master key in `KEY_ENCRYPTION_KEY` (Vercel env, never committed). No private material in client bundles.
- **Idempotency:** payment code relies on the DB unique `transactions.tx_hash` and the status machine `pending → submitted → confirmed | failed`; a reconciliation job resolves stuck `submitted` rows against Soroban RPC (SEP-41 contract mode; Horizon fallback for classic transactions).
- **Isolation:** Stellar and DB modules are `server-only`; route handlers stay light.
- **Anti-cheat:** HMAC-signed game sessions with TTL, per-user rate limits, server-side score bounds, nonce reuse rejection.
- **P2P & chat payments:** recipient resolution is server-side only (`telegram_username`, `telegram_id`, `forward_from`) — never trust a client-supplied recipient ID; the bot webhook validates the update signature against `TELEGRAM_BOT_TOKEN` on every request; chat payments require an inline confirm keyboard showing recipient + amount before signing; per-user send caps and rate limits (incl. new-account limits); `phone` is stored only after explicit one-time `requestContact` consent.
- **Admin console:** `/admin` re-checks the JWT session cookie and the DB role server-side before rendering (§7.10); every admin data access goes through `adminProcedure`, which re-reads the user's role from the DB on each request — a demotion takes effect on the next request. Non-admin sessions are redirected to `/`.
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
| Web user without a funded custodial account | Lazy provisioning (`ensureStellarAccount` + `retryAccountFunding`) on first spend; `ACCOUNT_NOT_READY` + retry CTA when funding is unavailable (e.g. mainnet) |
| Recipient with no custodial account | P2P fallback to their verified linked wallet (external bookkeeping); `RECIPIENT_NOT_ACTIVE` before any transaction when neither exists |
| Expired/used/replayed SEP-10 challenge | Single-use nonce memo consumed atomically; explicit errors; client re-issues a fresh challenge |
| Cold starts | Light tRPC procedures and route handlers; Neon HTTP driver pools connections; lazy Stellar SDK imports |
| Lost funding/issuer keys | Keys in Vercel env + documented backup procedure; `FUNDING`/`ISSUER` secrets never in code |
| Stuck payments | Reconciliation job: `submitted` → poll Soroban RPC → `confirmed` or `failed` |

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
| `WEBHOOK_SECRET_TOKEN` | server | Random secret for the bot webhook `secret_token` guard (optional; must be A-Z, a-z, 0-9, `_`, `-`) |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | both | Public bot username (no `@`) for QR `startapp` deep links |
| `KEY_ENCRYPTION_KEY` | server | AES-256-GCM master key for Stellar secrets |
| `STELLAR_NETWORK` | server | `testnet` (default) or `mainnet` |
| `HORIZON_URL` | server | Horizon endpoint for the active network |
| `SOROBAN_RPC_URL` | server | Soroban RPC endpoint used to invoke/read the TAK SEP-41 token contract (defaults to testnet) |
| `TAK_CONTRACT_ID` | server | TAK SEP-41 Soroban token contract address; setting it activates contract mode (SEP-41 `transfer` payments + `("Balance", address)` balance reads); unset → classic trustline fallback |
| `TAK_ISSUER_PUBLIC_KEY` | server | TAK issuer public key (from `scripts/setup-testnet.ts`) |
| `GAME_POOL_PUBLIC_KEY` | server | Espresso Roulette prize-pool public key (from `scripts/setup-testnet.ts`) |
| `GAME_POOL_SECRET_KEY` | server | Espresso Roulette prize-pool secret; signs reward/refund transfers (never leaves server env) |
| `CRON_SECRET` | server | Bearer secret guarding `/api/cron/lottery` |
| `JWT_SECRET` | server | JWT signing secret for the MiniApp session cookie (httpOnly) |
| `SEP10_SIGNING_KEY` | server | SEP-10 signing key for Stellar Web Authentication (Freighter/Albedo login/link). Its public key is derived at runtime and must match the `NEXT_PUBLIC_APP_URL` hostname; it must never equal a custodial user account (§7.11) |
| `NEXT_PUBLIC_APP_URL` | both | Public base URL of the app; its hostname is the SEP-10 home/web-auth domain |

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
