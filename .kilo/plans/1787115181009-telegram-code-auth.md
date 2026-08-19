# Telegram Code Sign-In (Passwordless web auth for Telegram-linked accounts)

## Goal

Give Telegram-linked users (numeric `telegram_id`, created via `/api/auth/tma` or admin with a numeric id) a way to sign in from the web **without a password**: they enter their username, the bot DMs them a one-time code, and the code signs them in. Also: in the signup form, when the entered username collides with a Telegram-addressable account, offer this code login instead of the `USERNAME_TAKEN` dead end.

Decisions (confirmed with user):
- **Passwordless** — the code is the credential; it replaces the password, it is not a second factor on top of it. Same trust boundary as TMA initData.
- **Signup collision** — detect a Telegram-addressable collision and offer code login.

This is the only web sign-in path for Telegram-only users today (password users and SEP-10 web users are separate identity classes — §5.3).

## Design

### New table: `telegram_codes` (in `src/db/schema.ts`)

```
telegram_codes
  id            text PK (uuid)
  user_id       text NOT NULL FK users.id
  code_hash     text NOT NULL        -- hex SHA-256 of the 6-digit code, never plaintext
  attempts      integer NOT NULL DEFAULT 0
  status        text enum ['pending','used','expired'] NOT NULL DEFAULT 'pending'
  expires_at    timestamptz NOT NULL
  consumed_at   timestamptz
  created_at    timestamptz NOT NULL DEFAULT now()
  indexes: idx(user_id, status), idx(user_id, created_at)
```

One active (`pending`) code per user: requesting a new code expires the previous pending one.

### New service: `src/services/auth-telegram-code.ts`

Constants:
- `CODE_LENGTH = 6`, `CODE_TTL_MS = 10 min`, `MAX_ATTEMPTS = 5`
- `REQUEST_COOLDOWN_MS = 60 s`, `RATE_LIMIT_WINDOW_MS = 15 min`, `RATE_LIMIT_MAX = 3`

`TelegramCodeError` with codes: `NOT_FOUND | RATE_LIMITED | RESEND_COOLDOWN | BOT_NOT_STARTED | SEND_FAILED | INVALID_CODE | CODE_EXPIRED | TOO_MANY_ATTEMPTS | INTERNAL`.

Functions:
- `isTelegramAddressable(user)` — `/^\d+$/.test(telegramId)` (rejects `password-*` / `web-*` / `manual-*` placeholders).
- `findTelegramLinkedUserByUsername(raw)` — trim+lower, reuse `getUserByUsername` (`@/services/users`), return user only if telegram-addressable, else null.
- `requestTelegramCode(username)`:
  1. Resolve user via `findTelegramLinkedUserByUsername`; none → `NOT_FOUND`.
  2. Rate limit: count `telegram_codes` rows for the user with `created_at > now - 15min`; `>= 3` → `RATE_LIMITED`. If a pending code exists created within the last 60 s → `RESEND_COOLDOWN`.
  3. Generate `randomInt(0, 1_000_000).toString().padStart(6, "0")` (node:crypto `randomInt`); store `sha256(code)` hex, `expires_at = now + TTL`.
  4. Expire all existing pending rows for the user, insert the new row.
  5. `sendMessage({ chatId: Number(user.telegramId), text: bot.codeMessage.replace("{code}", code) })` (reuse `@/lib/telegram-api`, import `faMessages` like `bot.ts` does).
  6. On send failure: expire the fresh row; if the error text matches `/can't initiate conversation|403/i` → `BOT_NOT_STARTED` (user must open the bot and press Start), else `SEND_FAILED`.
  7. Audit: `audit_log` row `auth.code_requested`. Never return the code in any response.
- `verifyTelegramCode(username, code)`:
  1. Resolve user; none → `INVALID_CODE` (generic — no enumeration on the verify step).
  2. Latest pending row for the user; none → `INVALID_CODE`.
  3. Expired (`expires_at < now`) → mark `expired`, `CODE_EXPIRED`.
  4. Timing-safe compare (`timingSafeEqual`) of `sha256(code.trim())` vs `code_hash`; on mismatch increment `attempts`, and at `MAX_ATTEMPTS` mark expired and throw `TOO_MANY_ATTEMPTS`, else `INVALID_CODE`.
  5. On match: mark `used` + `consumed_at`, audit `auth.code_verified`, return the `users` row.

### New plain Route Handlers (consistent with §8.2 — auth routes are plain handlers)

- `src/app/api/auth/telegram-code/request/route.ts` — `POST`, public, Zod body `{ username }`. Maps errors: `NOT_FOUND`→404, `RATE_LIMITED`/`RESEND_COOLDOWN`/`TOO_MANY_ATTEMPTS`→429, `BOT_NOT_STARTED`→409, `SEND_FAILED`→502, else 400. Success → `{ ok: true }`.
- `src/app/api/auth/telegram-code/verify/route.ts` — `POST`, public, Zod body `{ username, code: /^\d{6}$/ }`. On success: `getStellarAccountByUserId`, `createSessionToken`, `setSessionCookie`, return `{ ok: true, user: { id, role }, accountStatus }` (mirrors `/api/auth/password/signin`). Errors: `INVALID_CODE`/`CODE_EXPIRED`→401, `TOO_MANY_ATTEMPTS`→429.

### Signup collision flag

`src/app/api/auth/password/signup/route.ts`: in the `AuthPasswordError` catch, when `code === "USERNAME_TAKEN"`, call `findTelegramLinkedUserByUsername(username)`; if found return `{ ok: false, error: "username_taken", codeLoginAvailable: true }` (409), else keep the current body. Password-account collisions (auth_credentials namespace) naturally return null and stay plain `USERNAME_TAKEN`.

### Bot changes (`src/services/bot.ts`)

- Add a friendly `/start` handler in `handleMessage` (before payment-intent parsing): match `/^\/start(\s|$)/` → send `startWelcome` and return. Existing tests only assert `parseCommand("/start") === null`, so nothing breaks. Required because code delivery only works once the user has started the bot.
- Extend the `botMessages` literal type with `codeMessage` (used by the service) and `startWelcome`. Add both to `messages/fa.json` and `messages/en.json` under `"bot"`.

### Client (`src/components/password-auth.tsx`)

- Extend `Mode` to `"signin" | "signup" | "code"`; add a third segmented tab (ورود با کد تلگرام).
- Code mode: username input + "send code" → `POST /api/auth/telegram-code/request`; then code input + verify → `POST /api/auth/telegram-code/verify`; on success invalidate `wallet.get` + `session.role` and call `onSuccess()` (same as password path).
- `bot_not_started` → show instructions with a link to `https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME}` (NEXT_PUBLIC vars are inlined client-side) and a retry button.
- Resend button with a 60 s client-side countdown on `RESEND_COOLDOWN`/success.
- Signup collision: extend local `AuthResponse` type with `codeLoginAvailable?: boolean`; when the signup POST returns it, show a banner with a button that switches to code mode, pre-filled with the typed username.
- `onboarding-gate.tsx` needs no change (it already renders `PasswordAuth` only outside Telegram).

### i18n

Add a `"telegramCode"` section to `messages/fa.json` + `messages/en.json`: title, subtitle, username, sendCode, sendingCode, codeSent, codeLabel, verify, verifying, resend, resendIn, accountNotFound, invalidCode, codeExpired, codeAttempts, rateLimited, resendCooldown, botNotStarted, openBot, sendFailed, signupCollision, switchToCode, generic. Bot section: `startWelcome`, `codeMessage` (contains `{code}`, TTL note, and "ignore if you didn't request").

## Ordered task list

1. `src/db/schema.ts`: add `TELEGRAM_CODE_STATUSES` enum + `telegramCodes` table; run `pnpm db:generate` and `pnpm db:migrate`.
2. `src/services/auth-telegram-code.ts`: implement service per design.
3. Routes: `src/app/api/auth/telegram-code/request/route.ts`, `src/app/api/auth/telegram-code/verify/route.ts`.
4. `src/services/bot.ts`: `/start` welcome + message type/keys.
5. `src/app/api/auth/password/signup/route.ts`: `codeLoginAvailable` flag.
6. `messages/fa.json` + `messages/en.json`: `telegramCode` section + bot keys.
7. `src/components/password-auth.tsx`: third mode, code form, resend countdown, `bot_not_started` UX, signup-collision banner.
8. Tests:
   - New `src/services/__tests__/auth-telegram-code.test.ts` (mock `@/db` via `createFakeDb`, `@/services/users`, `@/lib/telegram-api`). Cases: unknown username / non-numeric telegram_id → `NOT_FOUND` (no send); success → row hash is SHA-256 + `sendMessage` called with numeric chat id + text containing code; previous pending invalidated on re-request; `RATE_LIMITED` at 3 per 15 min; `RESEND_COOLDOWN`; send failure "can't initiate conversation" → `BOT_NOT_STARTED` + row expired; verify success marks `used`; wrong code increments attempts, `TOO_MANY_ATTEMPTS` at 5; expired → `CODE_EXPIRED`; used/garbage → `INVALID_CODE`; unknown username on verify → `INVALID_CODE`; `findTelegramLinkedUserByUsername` filters non-numeric ids.
   - `src/services/__tests__/bot.test.ts`: add a case that `/start` sends the welcome and does not attempt a payment.
9. `ARCHITECTURE.md`: add `telegram_codes` row to §6 table, a short §7.13 flow, the two new routes in §8.2, and a security bullet in §10 (code delivery, hashing, attempts/rate limits, BOT_NOT_STARTED).
10. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Security model

- Code = 6 digits (10^6 space); mitigated by `MAX_ATTEMPTS = 5` per code + send rate limit (3 codes / 15 min per user, 60 s cooldown) → ≤15 guesses per 15 min; each re-request DMs the legitimate owner.
- Only SHA-256 hashes stored; never return or log the code. Timing-safe compare.
- Resolution is server-side only: username → numeric `telegram_id`; client never supplies the recipient id.
- `NOT_FOUND` vs success on the request step reveals whether a public username is Telegram-linked — accepted trade-off (handles are a public community directory; §7.8). The verify step never distinguishes unknown users.
- Session issuance is identical to password signin (`createSessionToken` + httpOnly `cb_session` cookie).

## Failure modes

| Failure | Handling |
|---|---|
| User never started the bot | `BOT_NOT_STARTED` → UI shows `t.me/<bot>` + Start instruction and a retry button; fresh `/start` welcome added to the bot |
| Telegram API transient failure | Fresh code row expired, `SEND_FAILED` → retry |
| Stale/used code | `INVALID_CODE`; re-request issues a new code and invalidates old pending ones |
| Brute force | Attempts cap + send rate limit |
| Vercel cold start | Stateless handlers; `telegram_codes` in Postgres only |

## Out of scope / notes

- True "password + code" 2FA: not built; the passwordless code replaces the password (decision).
- No per-IP rate limiting (no Redis on serverless); per-user limits only. A shared store (Upstash) is a later hardening option.
- Pre-existing debug artifacts unrelated to this feature (not fixed here): commented-out early return in `src/app/api/bot/webhook/route.ts`, and `1==1 ||` short-circuit in `verifyTelegramSignature3rd` at `src/lib/telegram.ts:67` (the @tma.js HMAC path still runs first; the 3rd-party fallback is always-true). Flag for a separate security fix.
