# Username/Password Auth — Alternative Sign-In (SignUp/SignIn)

Add a username + password auth mode alongside Telegram (TMA) and SEP-10 (Stellar wallet) sign-in. On signup the server creates a normal `users` row plus a custodial Stellar account **eagerly** (like the TMA flow), so password users can immediately buy/send coffee.

**Decided:** the chosen username is the user's **public handle** — it lives in the existing community-handle column (`users.telegram_username`) and is addressable in the MiniApp recipient search and bot `/coffee @handle` commands. Telegram and password users share one handle namespace (enforced by a lowercase unique index).

## 1. Data model (`src/db/schema.ts`)

1. Add `sql` import from `drizzle-orm`.
2. Add a **lowercase unique index** on the existing handle so Telegram + password usernames share one namespace (Postgres ignores NULLs in unique indexes, so Telegram-only users with `telegram_username = null` are unaffected):
   ```ts
   uniqueIndex("users_telegram_username_lower_unique").on(sql`lower(${table.telegramUsername})`)
   ```
3. Add new table `auth_credentials`:
   | column | type | notes |
   |---|---|---|
   | `id` | `text` PK, `crypto.randomUUID()` | |
   | `userId` | `text` NOT NULL FK→`users.id` | `uniqueIndex` (one credential set per user) |
   | `username` | `text` NOT NULL | stored **lowercase**; `uniqueIndex` |
   | `passwordHash` | `text` NOT NULL | scrypt string (see §2) |
   | `failedAttempts` | `integer` NOT NULL default `0` | brute-force lockout |
   | `lockedUntil` | `timestamp` nullable | lockout window |
   | `passwordChangedAt` | `timestamp` NOT NULL default now | |
   | `createdAt` / `updatedAt` | timestamps | |

   Match the existing table-style conventions (`uniqueIndex` in the table config array, not column `.unique()`).

4. Run `pnpm db:generate` and apply with `pnpm db:migrate`. Migration `0002_*.sql` must include both the new table and the expression index. Existing data is safe (Telegram enforces globally-unique handles).

## 2. Password hashing (`src/lib/password.ts`, new, `server-only`)

Zero new dependencies — use `node:crypto` (consistent with `src/lib/crypto.ts`):

- `hashPassword(password): Promise<string>` → `promisify(scrypt)(password, salt, 64, { N: 16384, r: 8, p: 1 })` with a per-user random 16-byte salt. Store as `scrypt$N$r$p$<salt hex>$<hash hex>`.
- `verifyPassword(password, stored): Promise<boolean>` → parse stored params, re-derive, compare with `timingSafeEqual`.
- Validate password policy in the service: min 8, max 128 chars.

## 3. Service (`src/services/auth-password.ts`, new, `server-only`)

Add `AuthPasswordError extends Error` with codes `INVALID_USERNAME`, `WEAK_PASSWORD`, `USERNAME_TAKEN`, `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `INTERNAL` (mirrors `AuthChallengeError` pattern; add to `typedErrorCode` in `src/server/trpc/middleware.ts` only if used via tRPC — not needed for plain handlers).

- `normalizeUsername(raw)` → trim + `.toLowerCase()`; validate `/^[a-z0-9_]{5,32}$/` (compatible with bot `parseCommand` `@([A-Za-z0-9_]{5,32})`).
- `signupWithPassword({ username, password })`:
  1. normalize + validate; hash password.
  2. Insert `users`: `telegramId: "password-" + crypto.randomUUID()`, `telegramUsername: username`, `firstName: username`, role `member`.
  3. Insert `auth_credentials` (`userId`, `username`, `passwordHash`).
  4. Insert zero `balances` row (same as `resolveStellarLogin`).
  5. `await ensureStellarAccount(user.id)` — eager, exactly like the TMA route (`/api/auth/tma`).
  6. Insert `audit_log` entry `{ actorUserId, action: "auth.signup", entity: "users", entityId }`.
  7. Catch any duplicate-key error (covers both `auth_credentials.username` and the new `users_telegram_username_lower_unique` collision with a Telegram user's handle) → `USERNAME_TAKEN`. Use catch-and-return, not a pre-check race.
  - Return `{ user, accountStatus }`.
- `signinWithPassword({ username, password })`:
  1. Look up `auth_credentials` by normalized username; if absent → `INVALID_CREDENTIALS` (identical to wrong-password error — no user enumeration).
  2. If `lockedUntil > now` → `ACCOUNT_LOCKED`.
  3. `verifyPassword`; on failure increment `failedAttempts`; when it reaches **5**, set `lockedUntil = now + 15 min` and reset the counter; throw `INVALID_CREDENTIALS`. On success reset `failedAttempts`/`lockedUntil`, load the `users` row by id, return it.

## 4. Route handlers (public, plain handlers like `/api/auth/tma`)

New files, both POST, same shape as existing auth routes (`bodySchema.safeParse` → service → `createSessionToken` → `setSessionCookie` → JSON).

- `src/app/api/auth/password/signup/route.ts` — body `{ username, password }` (confirm field is client-only). Response `{ ok, user: {id, role}, accountStatus }`. Error mapping: `USERNAME_TAKEN`→409, `INVALID_USERNAME`/`WEAK_PASSWORD`→400, `ACCOUNT_LOCKED`→429, else 500.
- `src/app/api/auth/password/signin/route.ts` — body `{ username, password }`. Same response shape (load `accountStatus` via `getStellarAccountByUserId`). Error mapping: `INVALID_CREDENTIALS`→401, `ACCOUNT_LOCKED`→429, else 500.

No tRPC changes and no `env` changes — the existing `cb_session` JWT cookie (`src/lib/auth.ts`) and `createTRPCContext` work unchanged; `SessionUser.telegramId` simply carries the `password-<uuid>` placeholder.

## 5. Telegram onboarding collision handling (`src/services/users.ts`)

The new lowercase-unique handle index can reject a Telegram user whose handle matches an existing password user's handle (or another Telegram user). In `upsertUserFromTelegram`:

- **INSERT path:** catch the duplicate-key error and retry the insert with `telegramUsername: null` (the user still onboards; their handle just isn't registered in-app). Log the collision.
- **UPDATE path:** if setting `telegramUsername` conflicts, keep the previous handle instead of throwing.

## 6. Admin handle-edit sync (`src/services/admin.ts`)

`updateUserForAdmin` allows editing `telegramUsername`, which is now also the login username for password users. When a user has an `auth_credentials` row and `telegramUsername` is changed, update `auth_credentials.username` in the same call so login keeps working.

## 7. Client UI

- `src/components/password-auth.tsx` (new, `"use client"`): tabbed Sign-in / Sign-up form. Fields: username, password (+ confirm on sign-up). POSTs to the two handlers, then invalidates `wallet.get` + `session.role` and calls `onSuccess` (same pattern as `web-login.tsx`). Shows `accountStatus === "pending_funding"` notice (existing `onboarding.pendingFunding` key).
- `src/components/onboarding-gate.tsx`: in the guest branch, outside Telegram (`!insideTelegram`), render `<PasswordAuth onSuccess={...} />` alongside `<WebLogin />` (divider label "or"). Inside-Telegram branch unchanged.
- i18n — add `passwordAuth` namespace to `messages/en.json` + `messages/fa.json`: titles, labels (`username`, `password`, `confirmPassword`), buttons (`signin`, `signup`, `signingIn`, `signingUp`), errors (`invalidCredentials`, `accountLocked`, `usernameTaken`, `usernameInvalid`, `passwordWeak`, `confirmMismatch`, `generic`), `or` divider.

## 8. Docs

Update `ARCHITECTURE.md`:
- §5.3: mention `password-<uuid>` placeholder identity and the shared lowercase-unique handle namespace; password users cannot be addressed via Telegram chat paths (no numeric id) — same as web users — but can receive bot `/coffee` payments by username since the handle lives in `telegram_username`.
- New §7.12: sign-up/sign-in flow diagram (client → handler → service → Neon → Stellar eager account → JWT cookie).
- §8.2 table: add the two `/api/auth/password/*` routes.
- §10: password storage (scrypt, per-user salt, timing-safe compare), 5-failure/15-min per-username lockout, generic error to avoid enumeration, eager custodial account at signup.

## 9. Tests (vitest, `tests/helpers/fake-db.ts` pattern)

- `src/lib/__tests__/password.test.ts`: round-trip verify, wrong-password reject, unique salt, malformed stored-hash rejection.
- `src/services/__tests__/auth-password.test.ts`:
  - signup creates user (with `password-` telegramId), credential, zero balance, and calls `ensureStellarAccount` (mock `@/services/users`/stellar).
  - signup duplicate username → `USERNAME_TAKEN`; signup colliding with an existing `users` row handle → `USERNAME_TAKEN`; case-insensitive normalization.
  - signin success resets `failedAttempts`; wrong password increments; 5 failures → `lockedUntil` set and `ACCOUNT_LOCKED`; lock cleared after window.
  - signin with unknown username → `INVALID_CREDENTIALS` (same code as wrong password).
- `src/services/__tests__/users.test.ts`: Telegram upsert with a colliding handle falls back to null handle; update path preserves the old handle on conflict.
- `src/services/__tests__/admin.test.ts`: handle edit syncs `auth_credentials.username`.

## 10. Validation

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Generate + apply the migration (`pnpm db:generate`, `pnpm db:migrate`).

## Out of scope / risks

- **Password reset / change-by-user:** no email/SMS channel exists; out of scope. An admin reset could reuse `admin.users.update` later.
- **Linking a password account to a Telegram account (merging identities):** out of scope.
- **Per-IP sign-up/sign-in throttling:** serverless needs a DB table; only per-username lockout ships now (future hardening).
- **`unlinkWallet` LAST_WALLET guard** (`src/services/auth-stellar.ts:332`): untouched — it only blocks `web-` prefixed users, and password users keep an independent sign-in method.
- **Migration risk:** the lowercase-unique index fails to create if existing data already has duplicate lowercase handles; production data is Telegram-enforced unique, verify the test/seed DB first.
