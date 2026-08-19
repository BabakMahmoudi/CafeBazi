# Espresso Roulette (رولت اسپرسو) — Implementation Plan

## Goal

Ship the first playable game end-to-end: a coffee-themed prize wheel in the Telegram MiniApp where members win real TAK (coffee) from a dedicated GAME_POOL custodial Stellar account. Free spins are daily-capped; optional paid spins cost 1 TAK and have better odds. Graphics are procedural SVG + CSS animation + Telegram haptics — zero new asset dependencies.

## Decisions (resolved)

- **Prize model:** winning slots pay real TAK, transferred on-chain GAME_POOL → member (`transactions.type = "game_reward"`).
- **Access:** 1 free spin/day per member (constant) + paid spins at 1 TAK each (entry fee transfers member → GAME_POOL, `transactions.type = "game_entry"`), capped at 10 paid spins/day.
- **Anti-cheat:** outcome is drawn server-side via CSPRNG. The client only animates to the server-chosen slot. Existing HMAC-session model (`game_sessions`) is reused as-is; no client-supplied score/outcome.
- **Graphics:** single SVG wheel generated at runtime from slot config, rotated with a CSS `transition: transform` ease-out; emoji slot markers; haptic feedback via the already-installed `@telegram-apps/sdk-react`; CSS confetti on wins. No new npm packages, no image assets.
- **Config:** wheel slots/weights/caps live as constants in `src/services/games.ts` (admin tuning is a later phase; no new DB table).
- **Page/nav:** new page `/[locale]/game`; a "بازی / Play" link added to the home nav row.

## Files to change

| File | Change |
|---|---|
| `src/db/schema.ts` | Add `"game_entry"`, `"game_reward"` to `TRANSACTION_TYPES` |
| `drizzle/` | Regenerated migration via `pnpm db:generate` |
| `src/lib/env.ts` | Add required `GAME_POOL_PUBLIC_KEY`, `GAME_POOL_SECRET_KEY` |
| `tests/setup.ts` | Test defaults for the two new env vars |
| `scripts/setup-testnet.ts` | Create/fund GAME_POOL (friendbot, TAK trustline, ~2000 TAK issue), persist in `.env.testnet.json`, print the new public key |
| `src/services/games.ts` | **New** — game service: session issuance, HMAC, weighted draw, fee + prize transfers, audit |
| `src/server/trpc/root.ts` | Add `games` router (`session`, `spin`) with Zod input schemas |
| `src/server/trpc/middleware.ts` | Add `GameError` to `typedErrorCode` |
| `src/services/__tests__/games.test.ts` | **New** — service unit tests (fake-db + mocked stellar, same pattern as `payments.test.ts`) |
| `src/server/trpc/__tests__/games.test.ts` | **New** — procedure auth/validation tests |
| `src/app/[locale]/game/page.tsx` | **New** — server page shell |
| `src/components/espresso-roulette.tsx` | **New** — client game component (state machine, spin, haptics, confetti) |
| `src/components/roulette-wheel.tsx` | **New** — pure SVG wheel (slots, pointer, hub) |
| `src/components/onboarding-gate.tsx` | Add "بازی / Play" nav link |
| `messages/fa.json`, `messages/en.json` | Add `nav.game` + full `game.*` section |
| `ARCHITECTURE.md` | §5.1 GAME_POOL account row, §7.6 games flow, §8.1 `games.*` rows, §12 env table |

## Ordered tasks

### 1. Schema + env + testnet script

1. `src/db/schema.ts`: extend `TRANSACTION_TYPES` with `"game_entry"` and `"game_reward"`. Run `pnpm db:generate` (produces migration `0004_*.sql`); do **not** manually edit drizzle SQL.
2. `src/lib/env.ts`: add `GAME_POOL_PUBLIC_KEY: z.string().min(1, ...)`, `GAME_POOL_SECRET_KEY: z.string().min(1, ...)` (same style as `TAK_ISSUER_PUBLIC_KEY`).
3. `tests/setup.ts`: default the two new vars (e.g. pool pub `G...` / pool secret `S...` test values).
4. `scripts/setup-testnet.ts`: extend `TestnetKeys` with `gamePool`; fund it, add the TAK trustline, issue ~2000 TAK to it (`memo: "game pool"`); persist in `.env.testnet.json`; print `GAME_POOL_PUBLIC_KEY` for env setup.

### 2. Game service — `src/services/games.ts` (server-only)

Constants:
- `SESSION_TTL_MS = 10 * 60_000`
- `FREE_SPINS_PER_DAY = 1`
- `PAID_SPIN_COST = 1n`
- `PAID_SPINS_PER_DAY = 10`
- `SLOTS` — 8 fixed positions (`{ emoji, prize: bigint, labelKey }`): `🥀 0`, `☕ 1`, `🎁 2`, `🥀 0`, `👑 5`, `🥀 0`, `☕ 1`, `🎁 2`
- `FREE_WEIGHTS = [20,15,5,20,2,20,15,3]` (sums 100; burnt 60 / cup 30 / double 8 / jackpot 2)
- `PAID_WEIGHTS = [10,22,9,10,7,10,22,10]` (sums 100; burnt 30 / cup 44 / double 19 / jackpot 7)

Functions:
- `createGameSession(userId)`: daily free-spin check (count `game_sessions` rows for `(userId, game="espresso_roulette")` created today ≥ `FREE_SPINS_PER_DAY` → `GameError("RATE_LIMIT")`); generate `nonce` + `hmac = HMAC-SHA256(KEY_ENCRYPTION_KEY, game|userId|nonce)`; insert `game_sessions` (`status: "active"`, `expires_at = now + TTL`). Return `{ sessionId, nonce, hmac, expiresAt, freeSpinsRemaining, paidSpinCost, paidSpinsRemaining }`.
- `verifySessionHmac(...)`: constant-time HMAC compare, `expires_at` check, then guarded single-use update `status: "active" → "used"` (0 rows → `SESSION_USED`). Rejection codes: `SESSION_INVALID`, `SESSION_EXPIRED`, `SESSION_USED`.
- `drawOutcome(spinType)`: weighted pick over `SLOTS` positions using `randomInt` from `node:crypto` over cumulative weights.
- `spinRoulette({ userId, sessionId, nonce, hmac, spinType })` — wrapped in `withAccountLock("user:" + userId)` (reuse from `payments.ts`):
  1. Verify session (above).
  2. If `paid`: enforce daily paid cap (count today's `transactions.type = "game_entry"` for user); ensure user has an active Stellar account (`ensureStellarAccount` / `getStellarAccountSecret`, reusing the `activateSender` retry pattern → `ACCOUNT_NOT_READY`); check cached + on-chain balance ≥ 1 (`INSUFFICIENT_FUNDS`); build+sign member → `env.GAME_POOL_PUBLIC_KEY` transfer via `buildSignedPayment`; insert `transactions` row (`type: "game_entry"`, unique `tx_hash` idempotency); `submitEnvelope`; on confirmed apply `-1` balance delta (mirror `payments.ts` status machine).
  3. `drawOutcome`; if `prize > 0n`: transfer `env.GAME_POOL_PUBLIC_KEY` → member (pool secret from env), insert `transactions` row (`type: "game_reward"`), submit, on confirmed apply `+prize` balance delta. **If the prize transfer fails, attempt one automatic refund transfer pool → member of `PAID_SPIN_COST`; if that also fails, write an `audit_log` entry with `metadata: { needsRefund: true }` and throw `POOL_UNAVAILABLE`.**
  4. Insert `game_scores` row (`score = position index`).
  5. `audit_log` entry `{ action: "game.spin", entity: "game_scores", metadata: { game, spinType, position, prize, prizeTx, feeTx } }`.
  6. Return `{ outcome: { position, emoji, prize, labelKey }, freeSpinsRemaining, paidSpinsRemaining, prizeTxHash?, feeTxHash?, balance }`.
- `GameError` class (`message`, `code`: `SESSION_INVALID | SESSION_EXPIRED | SESSION_USED | RATE_LIMIT | INSUFFICIENT_FUNDS | ACCOUNT_NOT_READY | POOL_UNAVAILABLE | INTERNAL`), patterned on `PaymentError`.

### 3. tRPC — `root.ts` + `middleware.ts`

- `middleware.ts`: register `GameError` in `typedErrorCode` so `data.typedCode` reaches the client.
- `root.ts`: `games: router({ session: protectedProcedure.mutation(...), spin: protectedProcedure.input(z.object({ sessionId: z.string().min(1), nonce: z.string().min(1), hmac: z.string().min(1), spinType: z.enum(["free", "paid"]) })).mutation(...) })`.

### 4. UI

- `roulette-wheel.tsx` (pure SVG, `"use client"` not required): props `{ slots, size?, spinDeg }`. 8 segments via polar-coordinate `<path>` arcs; alternating fills from the existing palette (`--accent`, `--accent-soft`, cream `#faf6f0`, dark `#241a12`, gold for the jackpot segment); emoji `<text>` markers rotated to each segment center; center hub circle with glow; fixed pointer triangle at the top. Outer container `style={{ transform: rotate(spinDeg), transition: "transform 4.5s cubic-bezier(0.12, 0.8, 0.18, 1)" }}`, `will-change: transform`.
- `espresso-roulette.tsx` (`"use client"`):
  - State machine: `idle → spinning → result`. On mount, `games.session` mutation; show wheel once a session exists.
  - Spin handler: call `games.spin` (free if `freeSpinsRemaining > 0`, else paid). On response, compute `targetRotation = 5 * 360 + (slotCenterForPosition - currentRotation mod 360)`, set it, and await `transitionend`. On `SESSION_EXPIRED`/`SESSION_USED`/`SESSION_INVALID` → auto-request a fresh session and retry once.
  - Haptics (guarded by `isHapticFeedbackSupported()`, wrapped in try/catch): `hapticFeedbackImpactOccurred("medium")` at spin start; `hapticFeedbackNotificationOccurred("success")` on win, `("error")` on miss.
  - Win reveal: prize banner (emoji + label + "N تک"), CSS confetti (~20 absolutely-positioned spans + `@keyframes` added to `globals.css`), balance refresh via `trpc.wallet.get.invalidate()`.
  - Controls: big "چرخش" (Spin) button; secondary "1 تک" paid-spin button shown when free spins are exhausted and paid spins remain; inline counters (`freeSpinsRemaining`, `paidSpinsRemaining`).
  - Errors mapped from `data.typedCode` → `game.*` i18n keys.
- `game/page.tsx`: mirror `buy/page.tsx` — `<main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">`, `<h1>{t("title")}</h1>`, `<EspressoRoulette />`.
- `onboarding-gate.tsx`: add `<Link href="/game">` (styled like the other nav buttons) using `t("nav.game")`.
- `globals.css`: add confetti keyframes (reuse the `brewing` pattern).
- i18n keys (`fa` + `en`): `nav.game`; `game.title`, `game.subtitle`, `game.spin`, `game.spinning`, `game.freeSpin`, `game.paidSpin`, `game.spinsLeft` (`{n}`), `game.paidSpinsLeft`, `game.youWon` (`{prize}`), `game.noWin`, `game.loading`, `game.slots.{burnt,cup,double,jackpot}`, `game.errors.{session,rateLimit,insufficient,accountNotReady,poolUnavailable,generic}`.

### 5. Tests

- `services/__tests__/games.test.ts` (mock `@/db` + `@/services/stellar` like `payments.test.ts`):
  - HMAC verify: tampered hmac/expired/used → correct `GameError` codes; valid pass.
  - Free-spin daily cap enforced by `game_sessions` count.
  - Paid-spin daily cap enforced by `game_entry` count.
  - Weighted draw: mock `randomInt` boundaries → expected position; weight arrays sum to 100 (assert).
  - Free spin win: no fee tx, `game_reward` tx + balance + game_scores + audit written.
  - Paid spin: fee tx first, then prize tx; `INSUFFICIENT_FUNDS` when balance 0; prize-failure refund path.
- `server/trpc/__tests__/games.test.ts`: unauthenticated → `UNAUTHORIZED`; bad Zod input rejected; typed error codes surface on `GameError`.
- Keep e2e light: extend the existing smoke spec pattern to assert `/game` renders the wheel container (no real Stellar calls).
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`.

### 6. Docs

- `ARCHITECTURE.md`: §5.1 add GAME_POOL account row; §7.6 rewrite the games flow to the `session → spin` design; §8.1 add `games.session`/`games.spin` rows; §12 env table add `GAME_POOL_PUBLIC_KEY` / `GAME_POOL_SECRET_KEY`.

## Security & failure notes

- Outcome and odds are 100% server-side; the wheel animation cannot change the result.
- Fee and prize transfers reuse the idempotent `transactions.tx_hash` unique + `pending → submitted → confirmed | failed` machine.
- Pool secret lives only in server env (same posture as `ISSUER`/`FUNDING` secrets); never in code or client bundles.
- Prize-transfer failure auto-refunds the entry fee; a failed refund is surfaced via `audit_log` metadata for a later reconciliation job (consistent with §11 stuck-submitted model).
- `withAccountLock` serializes per-user fee/prize transfers against the existing payment flow.

## Out of scope

- Admin tuning UI / DB-backed wheel config (constants are the v1 surface).
- Lottery-ticket prizes, leaderboards, streak bonuses, replay/share flows.
- Raster artwork; pool budget governance (operators fund GAME_POOL like LOTTERY_POOL).
