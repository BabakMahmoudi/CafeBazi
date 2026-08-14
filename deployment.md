I'm in **Ask mode (read-only)** — I cannot create or modify files in the repository, so I can't write `deployment.md` myself in this session. Here is the exact content to save as `deployment.md` (same steps as the `vercel.md` draft, renamed for your file). Switch to Code mode and I'll write this file and run the deployment for you.

---

```markdown
# Deploying Cafe Bazi to Vercel

> Status: Phases 1–3 (foundation, payments + P2P, chat payments) are implemented and the
> production build passes. **Before deploying a usable pilot, fix the blockers in §0** —
> the app will boot without them, but real users cannot complete a purchase.

## 0. Known blockers — fix before deploying (all in the codebase today)

1. **Trustline is never submitted at onboarding**
   `src/services/users.ts` → `ensureStellarAccount()` calls `addTrustline(...)` but
   discards the signed envelope and never calls `submitEnvelope()`. New accounts are
   marked `active` without a TAK trustline, so every TAK payment fails with `op_no_trust`.
   Fix: `await submitEnvelope(trustline.envelopeXdr)` like `retryAccountFunding()` already does.

2. **Seeded shops have no merchant Stellar account**
   `scripts/seed-dev.ts` creates an admin user + shops but no `stellar_accounts` row for the
   merchant. `payments.create` calls `getStellarAccountSecret(shop.merchantId)` and throws
   `"No active Stellar account for user"` for every purchase. Fix: create/fund the merchant
   account at seed time (or onboard the merchant through the MiniApp first).

3. **No TAK mint / top-up path**
   `admin.coins.mint` / `admin.coins.topUp` (documented in ARCHITECTURE.md §8.1) are not
   implemented. Users can never acquire a TAK balance through the app, and the `FUNDING`
   secret lives only in the local `.env.testnet.json` — not on the server. For a testnet
   pilot you must manually send TAK from `FUNDING` to user accounts via Horizon until a
   mint path exists.

4. **Mainnet funding is not implemented**
   `createFundedAccount()` is testnet-only (Friendbot). On mainnet, onboarding lands in
   `pending_funding`. This guide targets a **testnet pilot**; mainnet is Phase 6.

## 1. Prerequisites

- Node 22 (`nvm install 22`), pnpm
- Vercel account + CLI: `npm i -g vercel`
- Neon Postgres (production branch)
- Telegram bot token (BotFather) + bot username
- Stellar testnet accounts (from §2.2)

## 2. Local preparation (one-time)

```bash
pnpm install
cp .env.example .env.local   # fill in real values
```

Generate the two secrets and put them in `.env.local`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # KEY_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # JWT_SECRET
```

### 2.2 Stellar testnet accounts

```bash
pnpm db:testnet
```

This creates/funds `ISSUER` / `FUNDING` / `LOTTERY_POOL` and writes their keys to
`.env.testnet.json` (gitignored). **Back this file up** — it holds the FUNDING secret
needed to distribute TAK. Copy `TAK_ISSUER_PUBLIC_KEY` from the output into `.env.local`.

## 3. Database (Neon)

1. Create a Postgres branch in Neon and copy its connection string.
2. Point `DATABASE_URL` in `.env.local` at the **production** branch, then:

```bash
pnpm db:migrate            # creates all tables from drizzle/0000_*.sql
```

3. Seed admin + active shops (shops are required for the buy flow and QR pages):

```bash
# PowerShell
$env:SEED_ADMIN_TELEGRAM_ID="<your telegram id>"; pnpm db:seed
# bash/zsh
SEED_ADMIN_TELEGRAM_ID="<your telegram id>" pnpm db:seed
```

> There is no automatic migration step in the build — migrations and seeding must be run
> manually against the production DB before or right after the first deploy.

## 4. Create the Vercel project

```bash
vercel login
vercel link        # interactive; creates .vercel/ in the repo
```

In the Vercel dashboard for the project:

- **Node.js Version**: set to `22.x` (Project Settings → General). `package.json` already
  has `"engines": { "node": ">=22" }`, and `vercel.json` pins `nodejs22.x`.
- **Build Command**: `pnpm build` (auto-detected from package.json)
- **Install Command**: `pnpm install` (auto-detected from `packageManager`)

### 4.1 Environment variables

Set these in **Project Settings → Environment Variables** (all environments, or split
Preview vs Production as noted). `NEXT_PUBLIC_*` vars are inlined at build time, so they
must exist before the first build. The build **fails** if any required var is missing,
because `src/lib/env.ts` validates at module load:

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon production connection string |
| `TELEGRAM_BOT_TOKEN` | yes | initData HMAC + webhook secret-token |
| `KEY_ENCRYPTION_KEY` | yes | AES-256-GCM master key (base64, 32 bytes) |
| `TAK_ISSUER_PUBLIC_KEY` | yes | from `pnpm db:testnet` |
| `JWT_SECRET` | yes | MiniApp session cookie signing |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | yes | bot username without `@` (QR deep links) |
| `NEXT_PUBLIC_APP_URL` | yes | `https://<your-domain>.vercel.app` (webhook + QR) |
| `STELLAR_NETWORK` | dev | `testnet` default; `mainnet` in prod (Phase 6) |
| `HORIZON_URL` | dev | defaults to testnet Horizon |
| `CRON_SECRET` | prod | guards `/api/cron/lottery` (Phase 4; not needed yet) |

## 5. Deploy

```bash
vercel deploy --prod
```

The first build creates the deployment; subsequent `git push`/PRs deploy automatically
once the project is linked. Preview deployments use the Stellar testnet (default env).

## 6. Post-deploy steps

### 6.1 Register the bot webhook (required after every deploy)

```bash
# .env.local must point NEXT_PUBLIC_APP_URL at the production URL
pnpm bot:setwebhook
```

Registers `POST https://<your-domain>/api/bot/webhook` with secret-token mode
(`X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_BOT_TOKEN`).

### 6.2 Configure the bot in BotFather

- Set the **WebApp URL** to `https://<your-domain>` (the MiniApp root).
- Add the bot menu button → WebApp → same URL.
- Optionally set the commands (`/coffee @username [n]`).

### 6.3 Verify

1. `GET https://<your-domain>/api/health` → `{ "ok": true, ... }`
2. Open the bot's WebApp in Telegram → onboarding → confirm a `stellar_accounts` row is
   created with status `active` **and the TAK trustline exists on-chain** (blocker #1).
3. Buy-flow smoke test: since there is no mint path (blocker #3), manually send TAK from
   `FUNDING` to a test user's public key via Horizon, then complete a purchase and check
   the shop balance + audit log.
4. Forward a friend's message into the bot DM and confirm the inline keyboard flow.

## 7. Updating

```bash
vercel deploy --prod          # or push to the linked git repo
pnpm bot:setwebhook           # re-run after every deploy
```

## 8. Notes & gotchas

- **No auto-migrations**: run `pnpm db:migrate` + `pnpm db:seed` against the production
  DB yourself (or wire a CI step).
- **`vercel.json` `functions` glob** (`"**/*.ts"`) is effectively a no-op for Next.js —
  the Node runtime is controlled by Project Settings / `engines.node`. Safe to keep or clean.
- **In-memory account lock** (`withAccountLock`) is per-serverless-instance; real
  idempotency comes from the unique `transactions.tx_hash` and Stellar sequence numbers.
- **Stray files** `a.txt` / `idea.txt` are committed scratch files — remove them.
- Tests: `pnpm lint`, `pnpm typecheck`, `pnpm test` before deploying.
```

---

Switch to **Code mode** (write-capable) and ask me to create `deployment.md` with this content — I'll write the file to `D:\source\repos\CafeBazi\deployment.md` and can then execute the deployment steps (§4–§6) once `vercel login` or a `VERCEL_TOKEN` is available.