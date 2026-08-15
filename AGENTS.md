# AGENTS.md

Cafe Bazi is a community coffee-coin for Farmahin, Iran: a custodial Stellar wallet delivered as a Telegram MiniApp on Vercel serverless, where 1 TAK = 1 cup of coffee, with peer-to-peer gifting (in-app, pay-by-QR, and pay-by-message in the bot chat), games (Espresso Roulette, Brewing Speed Challenge, Barista Puzzle) and a weekly 100-TAK lottery. **Read `ARCHITECTURE.md` before any non-trivial change** — it is the single source of truth for the data model, API routes, env vars, and flows.

## Status

Roadmap Phases 1–3 are implemented (foundation, payments + P2P, chat payments). Games, lottery, merchant/store, and the AI/LLM layer are still ahead; their schema tables exist but are unused. The commands below are the live scripts in `package.json`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Start the dev server |
| `pnpm build` | Production build |
| `pnpm lint` | Lint |
| `pnpm typecheck` | TypeScript check |
| `pnpm test` | Run vitest unit/integration tests |
| `pnpm db:generate` | Generate Drizzle migrations from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm db:seed` | Seed admin user + active shops (needs `SEED_ADMIN_TELEGRAM_ID`) |
| `pnpm db:testnet` | Create/fund ISSUER/FUNDING/LOTTERY_POOL on the Stellar testnet |
| `pnpm bot:setwebhook` | Register the bot webhook with Telegram |

## Tech stack

Next.js 16 (App Router), React 19, TypeScript (strict), pnpm, **Node 22** (required by `@stellar/stellar-sdk@16.2.0`), Neon Postgres + Drizzle ORM, **tRPC v11 + Zod + superjson** for the end-to-end typed API (client side via `@tanstack/react-query`), `@tma.js/init-data-node@2.0.8` (NOT the deprecated `@telegram-apps/init-data-node`), `@telegram-apps/sdk-react@3.x`, `next-intl` (Persian-first RTL). TAK is a **SEP-41 Soroban token contract**: payments/balance reads use contract mode (`TAK_CONTRACT_ID` + `SOROBAN_RPC_URL`) with a classic trustline fallback; on-chain amounts are `i128 × 10^7`, the app layer is whole-TAK `bigint`.

## Conventions

- Strict TypeScript; path alias `@/*` → `src/*`.
- Components in `src/components`; tRPC router in `src/server/trpc`; plain route handlers in `src/app/api`; Drizzle schema in `src/db/schema.ts`.
- tRPC is the only client→server API transport. Plain Route Handlers exist only for external entry points: `/api/auth/tma`, `/api/bot/webhook`, `/api/cron/lottery`, `/api/health` (see ARCHITECTURE.md §8.2).
- Every tRPC procedure has a Zod input schema and runs behind `protectedProcedure`/`adminProcedure` — no untyped or unauthorized procedures.
- Admin console at `/admin` (`src/app/[locale]/admin/page.tsx`); all admin data flows through `admin.users.*` procedures behind `adminProcedure`, and the page redirects non-admins server-side.
- Stellar and DB access only via the service layer (`src/services`) — no raw Horizon/query calls in components or procedures.
- Stellar/DB modules are `server-only`; never import them from client bundles.
- Money is always an integer at the app layer: `bigint` in TS, `numeric` in Postgres. No decimals in app code; on-chain, TAK is `i128 × 10^7` (SEP-41) — the scaling constant (`TAK_DECIMALS`) lives in `src/services/stellar.ts`. `bigint` crosses the tRPC boundary via the superjson transformer.
- Persian-first, RTL; all UI text via next-intl keys (`fa` default, `en` fallback).
- No code comments unless asked. Match existing patterns.

## Rules

- Never commit or log secrets. `*.env*` is gitignored; `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `KEY_ENCRYPTION_KEY`, `CRON_SECRET` never leave server env.
- Payment code must be idempotent: rely on the unique `transactions.tx_hash` and the status machine `pending → submitted → confirmed | failed`.
- P2P and chat payments: resolve recipients server-side only (`telegram_username`, `telegram_id`, `forward_from`); never trust a client-supplied recipient. Bot webhook must validate every update against `TELEGRAM_BOT_TOKEN`.
- Verify Telegram initData server-side on every authenticated request; never trust client `window.Telegram.WebApp.initData` alone.
- After any change, run `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
