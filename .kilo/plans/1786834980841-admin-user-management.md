# Admin console — user management at `/admin`

## Goal

Add an admin-only page at `/admin` that (1) lists users with **name, Stellar account address, and TAK balance**, and (2) lets an admin **add and edit users**. Update project documents (ARCHITECTURE.md, README.md, AGENTS.md, deployment.md) to match.

## Context (verified in code)

- Pages live under `src/app/[locale]/`; `localePrefix: "as-needed"` with default `fa` means `/admin` resolves to `src/app/[locale]/admin/page.tsx` (`src/i18n/routing.ts`).
- No `admin` router exists yet in `src/server/trpc/root.ts` — `adminProcedure` middleware exists (`src/server/trpc/middleware.ts:23`) but is unused. ARCHITECTURE.md §8.1 documents `admin.coins.*`/`admin.shops.*` that are not implemented (pre-existing doc drift; leave them).
- Identity: `users` (`id`, `telegramId` UNIQUE, `telegramUsername`, `firstName`, `phone`, `role`). Address = `stellar_accounts.public_key` (no address column on users — **confirmed with user**). Balance = cached `balances.amount` (numeric), source of truth on-chain; `syncBalanceFromChain(userId)` in `src/services/wallet.ts` refreshes it.
- Reusable pieces: `ensureStellarAccount`/`getStellarAccountByUserId` (`src/services/users.ts`), `syncBalanceFromChain` (`src/services/wallet.ts`), `takFromNumeric` (`src/lib/money.ts`), superjson carries `bigint` over tRPC.
- Session: JWT httpOnly cookie set by `/api/auth/tma` (Telegram initData only) → `/admin` works inside the Telegram MiniApp for a `role = "admin"` user (seeded by `pnpm db:seed`).
- Tests use a fake in-memory DB (`tests/helpers/fake-db.ts`) that has **no `leftJoin`/`offset`/`count`** support — the admin list service must merge tables in code (users + balances + stellar_accounts via `IN`).

## Decisions (user-confirmed)

1. **"Address" = Stellar account public key** (`stellar_accounts.public_key`; `null` when the user has no account). No schema change.
2. **Balance is read-only** in the admin UI, with a per-user **"sync from chain"** action. No mint/top-up in this feature (mint path unimplemented, mainnet blocked).
3. **`telegramId` is immutable on edit** (set only at create). Editable: `firstName`, `telegramUsername`, `phone`, `role`.
4. **Create = user row + Stellar account** (via `ensureStellarAccount` — keypair, testnet funding, encrypted secret) **+ zero `balances` row**.
5. Access: server-side redirect for non-admins **plus** `adminProcedure` on every admin tRPC procedure (defense in depth).

## Implementation tasks (ordered)

### 1. Service layer — `src/services/admin.ts` (new, `server-only`)

Import `db`, `users`/`balances`/`stellarAccounts` schema, `takFromNumeric`, `ensureStellarAccount` (from `./users`), `syncBalanceFromChain` (from `./wallet`).

Type `AdminUserView = { id, telegramId, telegramUsername, firstName, phone, role, publicKey: string | null, accountStatus: StellarAccountStatus | null, balance: bigint, createdAt }`.

- `listUsersForAdmin({ query?, limit = 50, offset = 0 })`
  - Select `users` where `query` → ILIKE `firstName` OR `telegramUsername` (trimmed, max 64), `orderBy(desc(users.createdAt))`, fetch `limit + 1` rows.
  - One follow-up select for `balances` (`userId IN (...)`) and one for `stellar_accounts` (`userId IN (...)`) — no joins (fake-db constraint).
  - Merge into `AdminUserView[]`, slice to `limit`, return `{ items, hasMore }`.
- `createUserForAdmin({ firstName, telegramId?, telegramUsername?, phone?, role })`
  - Insert `users` (default `createdAt`/`updatedAt`); catch unique `telegramId` violation → `TRPCError CONFLICT` ("duplicate key").
  - `ensureStellarAccount(userId)` → `publicKey` + `accountStatus` (may be `pending_funding` on funding failure/mainnet).
  - Ensure a `balances` row (amount `"0"`) exists.
  - Return `AdminUserView`.
- `updateUserForAdmin({ userId, firstName?, telegramUsername?, phone?, role? })`
  - Load target; `NOT_FOUND` if missing.
  - Guards: if `role` is being changed to non-admin **and** target is the last admin → `FORBIDDEN`; if target is the requesting admin and new `role !== "admin"` → `FORBIDDEN` (self-lockout). Requesting admin id passed in from `ctx.user.id`.
  - Update fields + `updatedAt`; return `AdminUserView`.
- `syncUserBalanceForAdmin(userId)` → delegates to `syncBalanceFromChain(userId)` (returns `{ balance, synced }`; safe when no active account).

### 2. tRPC — `src/server/trpc/root.ts`

Import `adminProcedure` from `./middleware`. Add:

- `admin.users.list` — `adminProcedure.query({ input: z.object({ query: z.string().trim().max(64).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }) })` → `listUsersForAdmin`.
- `admin.users.create` — `adminProcedure.mutation({ input: z.object({ firstName: z.string().trim().min(1).max(100), telegramId: z.string().trim().regex(/^\d+$/).max(32).optional(), telegramUsername: z.string().trim().max(32).optional(), phone: z.string().trim().max(32).optional(), role: z.enum(USER_ROLES) }) })`.
- `admin.users.update` — `adminProcedure.mutation({ input: z.object({ userId: z.string().min(1), firstName: z.string().trim().min(1).max(100).optional(), telegramUsername: z.string().trim().max(32).optional(), phone: z.string().trim().max(32).nullable().optional(), role: z.enum(USER_ROLES).optional() }) })`, passes `ctx.user.id` as actor.
- `admin.users.syncBalance` — `adminProcedure.mutation({ input: z.object({ userId: z.string().min(1) }) })`.
- `session.role` — `protectedProcedure.query(({ ctx }) => ctx.user.role)` (drives the admin nav link).

### 3. i18n — `messages/fa.json` + `messages/en.json`

Add an `admin` namespace (Persian-first, mirroring existing style): `title`, `description`, `searchPlaceholder`, `addUser`, `editUser`, `name`, `username`, `phone`, `role`, `address`, `balance`, `status`, `createdAt`, `save`, `cancel`, `sync`, `syncing`, `synced`, `roleMember`, `roleMerchant`, `roleAdmin`, `accountActive`, `accountPendingFunding`, `accountDisabled`, `accountNone`, `noUsers`, `previous`, `next`, `notAdmin`, and `errors.{conflict,notFound,lastAdmin,generic}`.

### 4. Server page — `src/app/[locale]/admin/page.tsx` (server component)

- `getTranslations("admin")` for `title`.
- Guard: `getSessionToken()` → `verifySessionToken()` → load user from `users` by id (mirror `src/server/trpc/context.ts`); if no session or `role !== "admin"` → `redirect("/")`. (Server-only imports are fine here.)
- Render `<AdminUsersTable />` (client component).

### 5. Client component — `src/components/admin/users-table.tsx` ("use client")

- `trpc.admin.users.list.useQuery({ query, offset, limit })` with search input and prev/next pagination (`hasMore`).
- Row shows: `firstName` (+ `@telegramUsername`), Stellar `publicKey` (monospace, truncated + copy button; "no account" state), `balance` (+ `TAK`), `accountStatus`, `role`, `createdAt`.
- Per-row "sync" button → `trpc.admin.users.syncBalance.useMutation` → invalidate list.
- "Add user" button → create form (firstName, telegramId, username, phone, role).
- "Edit" per row → update form (firstName, username, phone, role; telegramId shown read-only).
- Show `errors.*` messages on mutation failure; use `useTranslations("admin")`.
- Reuse existing Tailwind card/button styles from `send-cup.tsx`/`balance-card.tsx`.

### 6. Navigation

`src/components/onboarding-gate.tsx`: query `trpc.session.role.useQuery()`; render an "Admin" `Link` to `/admin` (via `@/i18n/navigation`) in the member nav when `role === "admin"`.

### 7. Tests

- `src/services/__tests__/admin.test.ts` (fake-db, mock `@/db` + `@/services/users`/`@/services/wallet` for the reused fns, mirroring `users.test.ts` patterns):
  - `listUsersForAdmin` returns name/address/balance merged, respects `query` ILIKE and `limit`/`hasMore`.
  - `createUserForAdmin` inserts user + stellar account + zero balance; conflict on duplicate telegramId; `pending_funding` when funding fails.
  - `updateUserForAdmin` updates editable fields; rejects changing the last admin / self-demotion; `NOT_FOUND` for missing user.
  - `syncUserBalanceForAdmin` delegates and returns `{ balance, synced }`.
- `src/server/trpc/__tests__/admin.test.ts`: caller with member context → `FORBIDDEN` on `admin.users.list`; admin context works; Zod rejects bad input (e.g. empty `firstName`, non-digit `telegramId`).

### 8. Project documents

- **ARCHITECTURE.md**
  - §8.1: add `admin.users.list` / `admin.users.create` / `admin.users.update` / `admin.users.syncBalance` rows and a `session.role` row (marked as the first implemented `admin.*` procedures).
  - §9 directory tree: `[locale]/admin/page.tsx` and `components/admin/`.
  - New §7.10 "Admin console (user management)": list (cached balance, on-chain is source of truth), add (user + custodial account + zero balance), edit (telegramId immutable; last-admin/self-demotion guard), sync-from-chain; every call behind `adminProcedure` + server-side redirect.
  - §10 security: add the admin page guard bullet (server component re-checks the JWT session role; all admin data access behind `adminProcedure`).
- **README.md**
  - Features (implemented): add "Admin console at `/admin` — list users (name, Stellar address, balance), add/edit users, sync balances".
  - Project structure tree: `[locale]/admin/` page + `components/admin/`.
  - Note under Quickstart/seed: access requires logging into the MiniApp as the seeded admin.
- **AGENTS.md** — Conventions: add "Admin console at `/admin` (`src/app/[locale]/admin/page.tsx`); all admin data flows through `admin.users.*` procedures behind `adminProcedure`, and the page redirects non-admins server-side."
- **deployment.md** — §6.3 verify: add a step "open `/admin` as the seeded admin and confirm the user list renders" (optional, one line).

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Manual: `pnpm dev`; onboard the seeded admin in the Telegram MiniApp; open `/admin`; create a user, edit it, sync balance, paginate/search; confirm a member session is redirected from `/admin`.

## Risks & notes

- **Mainnet**: `ensureStellarAccount` can't fund on mainnet (`createFundedAccount` is testnet-only) → new users get `pending_funding` until Phase 6. Expected; surfaced in the UI via `accountStatus`.
- **Balance freshness**: list shows the cached `balances` row; the sync action refreshes it from the SEP-41 contract/Horizon. Do not N×1 on-chain reads for the whole list (1,000 users).
- **fake-db limits**: no joins/offset/count — the list service stays two-step (`users` then `IN` queries) so it stays testable and avoids N+1 in production.
- **Doc drift left untouched**: ARCHITECTURE.md's unimplemented `admin.coins.*`/`admin.shops.*`/`admin.inventory.*` rows stay as-is (separate roadmap work).
