# Cafe Bazi

A community coffee-coin for Farmahin, Iran — a custodial Stellar wallet as a Telegram MiniApp where **1 TAK = 1 cup of coffee**. Buy coffee, gift cups to friends (in-app, via QR, or by forwarding a message in the bot chat), play games, win the weekly lottery — no new app install.

> **Status: implemented through chat payments + Stellar web auth (roadmap Phases 1–3).** The Next.js scaffold, Telegram auth + SEP-10 web auth, data model, wallet read, payments + P2P (incl. linked-wallet fallback), QR fast-pay, and the chat-payment bot webhook are in place. Games, lottery, merchant/store, and the AI/LLM layer are still ahead. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

## How the coin works

- The community buys coffee **wholesale (~1 metric ton, ~30% discount)** and stores it centrally.
- **1 TAK = 1 cup of espresso** at any participating coffee shop in Farmahin — *tak* (تک) is Persian for a single espresso shot.
- TAK lives on-chain in a **SEP-41 Soroban token contract**; transfers and balance reads go through Soroban RPC (no trustlines).
- Shops send TAK to the store and receive **dry coffee**; the community shares the ~30% saving.
- Your coins live in a **custodial Stellar account**: the server holds and signs, keys are encrypted at rest. Coffee-themed games (Espresso Roulette, Brewing Speed Challenge, Barista Puzzle) and a **weekly 100-TAK lottery** make buying coffee fun.

## Features (implemented)

- Telegram MiniApp wallet — the community already uses Telegram, so no app install
- Web login — sign in from a browser with any Stellar wallet (SEP-10): Freighter on desktop, Albedo in any browser, and on mobile you open the page in your phone's browser; link external wallets as withdrawal destinations
- Custodial per-user Stellar accounts (testnet-first; mainnet path documented)
- Pay for coffee in TAK with a "brewing" pending animation
- Gift TAK to friends — recipient picker (username search + recents) inside the MiniApp; gifts to web-only users land in their linked external wallet
- Pay-by-QR — static per-shop/per-table cards deep-link into the app and pre-fill the order
- Pay-by-message — forward a friend's message into the bot chat and tap to buy them a cup
- Admin console at `/admin` — list users (name, Stellar address, cached balance), add/edit users, and sync balances from the chain
- Persian-first UI with RTL; English fallback

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) on Vercel serverless, **Node 22** |
| Language | TypeScript (strict), React 19, pnpm |
| Blockchain | Stellar (`@stellar/stellar-sdk@16.2.0`), TAK as a SEP-41 Soroban token contract (no trustlines) |
| Database | Neon Postgres + Drizzle ORM (`drizzle-orm@0.44+`, `@neondatabase/serverless@1.1.0`) |
| Typed API | tRPC v11 (`@trpc/server` + `@trpc/client` + `@trpc/react-query`) with Zod input schemas and superjson (`bigint` money); client side via `@tanstack/react-query` |
| Telegram | `@tma.js/init-data-node@2.0.8` (server-side auth) + `@telegram-apps/sdk-react@3.3.9` (client) |
| i18n | `next-intl` — `fa` default, `en` fallback, RTL |
| Tests | vitest (unit/integration), Playwright (e2e smoke) |

## Quickstart

Prerequisites: **Node 22** (`nvm install 22 && nvm use 22` — required by the Stellar SDK), pnpm (or the pnpm standalone installer on Windows: `iwr https://get.pnpm.io/install.ps1 -useb | iex`).

```bash
pnpm install
cp .env.example .env.local   # fill in real values
pnpm db:generate             # generates migrations from src/db/schema.ts
pnpm dev
```

With placeholder env vars the dev server boots and the MiniApp shell renders outside Telegram (a mocked launch environment is used); `/api/health` responds. Real services (Neon, Stellar testnet, Telegram bot) are opt-in — see below.

### Stellar testnet setup (optional, opt-in)

Creates `ISSUER` / `FUNDING` / `LOTTERY_POOL` on the Stellar testnet, funds them via Friendbot, issues initial `TAK`, and writes the keys to `.env.testnet.json` (gitignored):

```bash
pnpm db:testnet
# add TAK_ISSUER_PUBLIC_KEY from the output to .env.local
```

Seeds a local database with an admin user and two active shops (QR slugs `s1`, `s2`):

```bash
$env:SEED_ADMIN_TELEGRAM_ID="<your telegram id>"; pnpm db:seed
```

> Access to `/admin` requires logging into the MiniApp as the seeded admin (the seed sets `role = admin`).

### Bot webhook registration

Run after every deploy so Telegram routes updates to the bot:

```bash
pnpm bot:setwebhook   # registers ${NEXT_PUBLIC_APP_URL}/api/bot/webhook with secret-token mode
```

### Environment variables

| Var | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres connection string (server-only) |
| `TELEGRAM_BOT_TOKEN` | yes | Telegram bot token for initData validation + webhook secret (server-only) |
| `WEBHOOK_SECRET_TOKEN` | no | Random secret for the bot webhook `secret_token` guard (server-only) |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | yes | Public bot username (no `@`) used in QR `startapp` deep links |
| `KEY_ENCRYPTION_KEY` | yes | AES-256-GCM master key for Stellar secrets (server-only). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `STELLAR_NETWORK` | dev | `testnet` (default) or `mainnet` |
| `HORIZON_URL` | dev | Horizon endpoint for the active network |
| `SOROBAN_RPC_URL` | dev | Soroban RPC endpoint for the TAK SEP-41 token contract (defaults to testnet) |
| `TAK_CONTRACT_ID` | yes* | TAK SEP-41 Soroban token contract address; setting it activates contract mode (SEP-41 `transfer` payments + `("Balance", address)` balance reads); unset → classic trustline fallback |
| `TAK_ISSUER_PUBLIC_KEY` | yes* | TAK issuer public key (from `pnpm db:testnet`) (server-only) |
| `CRON_SECRET` | prod | Bearer secret guarding `/api/cron/lottery` (server-only) |
| `JWT_SECRET` | yes | JWT signing secret for the MiniApp session cookie (server-only). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `SEP10_SIGNING_KEY` | yes | SEP-10 signing key for Stellar Web Authentication (Freighter/Albedo login/link). Its public key must not be a user's custodial account (server-only). Generate: `node -e "import('@stellar/stellar-sdk').then(s => console.log(s.Keypair.random().secret()))"` |
| `NEXT_PUBLIC_APP_URL` | yes | Public base URL of the app |

\* required once any Stellar transaction runs; onboarding works in `pending_funding` without it.

Never commit `.env*` files or any of these values.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | Start the dev server |
| `pnpm build` | Production build |
| `pnpm lint` | Lint |
| `pnpm typecheck` | TypeScript check |
| `pnpm test` | Run vitest unit/integration tests |
| `pnpm db:generate` | Generate Drizzle migrations from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply Drizzle migrations (requires `DATABASE_URL`) |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm db:seed` | Seed admin user + active shops (`SEED_ADMIN_TELEGRAM_ID`) |
| `pnpm db:testnet` | Create/fund ISSUER/FUNDING/LOTTERY_POOL on the Stellar testnet |
| `pnpm bot:setwebhook` | Register the bot webhook URL with Telegram |

## Project structure

```text
src/
├─ app/
│  ├─ api/
│  │  ├─ trpc/[trpc]/route.ts   # tRPC HTTP handler (fetch adapter)
│  │  ├─ auth/tma/route.ts      # plain handler: initData → JWT cookie
│  │  ├─ auth/stellar/          # plain handlers: SEP-10 login challenge/verify
│  │  ├─ bot/webhook/route.ts   # plain handler: Telegram updates → chat payments
│  │  └─ health/route.ts        # public liveness probe
│  └─ [locale]/                 # i18n pages; fa default, RTL
│     ├─ admin/page.tsx         # admin console: user management
│     ├─ buy/page.tsx           # coffee purchase
│     ├─ send/page.tsx          # P2P gifting
│     ├─ wallets/page.tsx       # linked external wallets
│     └─ qr/[shopSlug]/page.tsx # shop/table QR card
├─ components/         # UI components (tRPC React Query hooks); components/admin/ = admin console
├─ db/                 # Drizzle schema + client (server-only)
├─ server/trpc/        # tRPC router: root.ts, context.ts, middleware.ts
├─ services/           # stellar, payments (purchase + P2P + chat), auth-stellar (SEP-10), users, wallet, recipients, shops, bot
├─ lib/                # env, auth, crypto, telegram, qr, telegram-api, trpc client/provider
└─ i18n/               # next-intl routing/request/navigation
├─ drizzle/            # generated migrations
├─ scripts/            # setup-testnet, seed-dev, set-webhook (opt-in, real services)
└─ tests/              # vitest setup + fake-db helper; e2e smoke
```

## Deployment (Vercel)

- Deploy the repo as a Next.js app; set the env vars above in the project settings.
- Runtime is **Node 22** (`vercel.json` pins `nodejs22.x`; `"engines": { "node": ">=22" }` in `package.json`).
- Configure the Telegram bot: WebApp MiniApp URL → `NEXT_PUBLIC_APP_URL`, point the bot menu/button to the MiniApp, and register the chat-payment webhook via `pnpm bot:setwebhook`.
- The weekly lottery (`/api/cron/lottery`) is scheduled in Phase 4; `vercel.json` crons are added then.
- Preview deployments use the Stellar testnet; production flips via `STELLAR_NETWORK=mainnet`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data model, API reference, security model, and failure-mode handling.

## Roadmap

1. **Foundation** — scaffold, auth, DB, key custody, wallet read ✅
2. **Payments + P2P** — buy coffee (incl. QR fast-pay), send cups to friends, contacts, reconciliation ✅
3. **Chat payments** — bot webhook, forward-to-pay, reply/command flows ✅
4. **Games + lottery** — HMAC-signed sessions, weekly draw
5. **Merchant/store** — shops, redemptions, inventory
6. **Mainnet launch hardening** — reserves, audit, observability
7. **AI/LLM (deferred)** — natural-language assistance, coffee knowledge, and fun/personality features (e.g. coffee fortunes, weekly recaps, gift-memo generation). Designed for but deliberately not scheduled; see ARCHITECTURE.md §16

## License

Proprietary. All rights reserved.
