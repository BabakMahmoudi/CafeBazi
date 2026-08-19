# SEP-10 Stellar Web Authentication (Freighter login + linked wallets)

Goal: make the web app usable as a normal website by adding a second auth method — Stellar Web Authentication (SEP-10) via the Freighter browser extension. Read `ARCHITECTURE.md` before editing; it is the source of truth.

## Context

Current auth is Telegram-only: `initData` → `POST /api/auth/tma` (`src/app/api/auth/tma/route.ts`) → upsert user → `ensureStellarAccount` → JWT `cb_session` httpOnly cookie. The proposal (external wallet auth) is SEP-10. The Stellar SDK 16.2.0 already ships the SEP-10 helpers (`WebAuth` namespace: `buildChallengeTx`, `readChallengeTx`, `verifyChallengeTxSigners` in `node_modules/@stellar/stellar-sdk/lib/esm/webauth/`) — use them, do not hand-roll SEP-10.

`payments.sendExternal` (`src/server/trpc/root.ts:67`, type `withdrawal`) already implements "move TAK from the in-app custodial wallet to a standard wallet". Only its UX (prefill the linked address) is new work.

## Decisions (user-confirmed)

1. **Scope:** existing Telegram members can link a Freighter wallet and sign in from the web; brand-new visitors can also sign in with Freighter and get an auto-provisioned account.
2. **Custodial timing:** web-only users get their custodial account lazily — created/funded via the existing `ensureStellarAccount`/`retryAccountFunding` only when they first perform an in-app action that needs it (buy, in-app send/receive, lottery). No funding at sign-in (preserves the XLM reserve budget).
3. **Gifting to web users:** `payments.send` to a recipient with no custodial account but a verified linked wallet pays that linked external address directly (their own wallet; no cached-balance credit). Recipients with neither get a clear "recipient not active" error.
4. **Custody model unchanged:** the linked wallet is an identity + withdrawal destination, never the payment account. No client-side signing of payments.

## Design

### 1. Schema — `src/db/schema.ts` (then `pnpm db:generate` + `pnpm db:migrate`)

- `wallet_links`: `id` (uuid pk), `userId` FK→users, `publicKey` text NOT NULL, `source` text default `"stellar"`, `label` text nullable, `verifiedAt` timestamp NOT NULL, `createdAt` default now. Index on `userId`; **unique on `publicKey`** (identity mapping, one wallet = one user).
- `auth_challenges`: `id` (uuid pk), `publicKey` text NOT NULL, `nonce` text NOT NULL (the challenge's uint64 memo), `purpose` text `["login","link"]` NOT NULL, `status` text `["pending","used","expired"]` default `pending`, `expiresAt` timestamp NOT NULL, `createdAt` default now. Unique on `nonce`; index on `status`.

No changes to `users`: web-only users reuse the existing placeholder pattern from `src/services/admin.ts:104`, i.e. `telegramId = "web-" + crypto.randomUUID()` (NOT NULL + UNIQUE preserved). Do NOT make `telegramId` nullable.

### 2. Env — `src/lib/env.ts`

- Add `SEP10_SIGNING_KEY` (server-only secret). Its public key is derived with `Keypair.fromSecret(...).publicKey()`.
- `homeDomain` / `webAuthDomain` derived from the `NEXT_PUBLIC_APP_URL` hostname (no new env). The challenge endpoint response includes `networkPassphrase` (server already knows it) so the client passes it to Freighter — no public network env needed.

### 3. Service — `src/services/auth-stellar.ts` (server-only)

- `issueChallenge({ publicKey, purpose })`: validate with `isValidStellarAddress`; reject if `publicKey` equals the SEP-10 signing key or any custodial `stellar_accounts.public_key`; DB rate limit (e.g. ≤10 pending challenges/hour per `publicKey`); `WebAuth.buildChallengeTx(sep10Keypair, publicKey, homeDomain, 300, networkPassphrase, webAuthDomain, randomUint64Nonce)`; insert `auth_challenges` row; return `{ challengeXdr, networkPassphrase, expiresAt }`.
- `verifyChallenge({ signedChallengeXdr, purpose })`: `WebAuth.readChallengeTx` → take `clientAccountID` (the challenge's **source account**, never a client-claimed address) and `memo`; `WebAuth.verifyChallengeTxSigners(signed, sep10Pub, passphrase, [clientAccountID], homeDomains, webAuthDomain)`; fetch the row by `nonce = memo`; require `status = pending`, `purpose` match, `expiresAt > now`; atomically mark `used` (single-use/replay protection); return `clientAccountID`.
- `resolveStellarLogin(publicKey)`: lookup `wallet_links.publicKey` → existing user; else create user (`telegramId = web-<uuid>`, `firstName` short-form like `GABC…XYZ` or a Persian "کاربر وب"), insert the `wallet_links` row, insert zero `balances` row. Return `{ user, isNewUser }`.
- `linkWallet(userId, publicKey)`: duplicate → clear `ALREADY_LINKED` conflict ("wallet already linked to another account"); reject custodial addresses; insert row.
- `unlinkWallet(userId, publicKey)`: block if it is the user's only wallet AND `telegramId` starts with `web-` (would remove their only sign-in method).

### 4. Plain route handlers (external entry points, §8.2) — login is unauthenticated

- `src/app/api/auth/stellar/challenge/route.ts`: POST `{ publicKey, purpose: "login" }` (public). Returns `{ ok, challengeXdr, networkPassphrase, expiresAt }`.
- `src/app/api/auth/stellar/verify/route.ts`: POST `{ signedChallengeXdr, purpose: "login" }` (public). Verify → `resolveStellarLogin` → `createSessionToken({ sub, telegramId: user.telegramId, role })` → `setSessionCookie` → `{ ok, user: { id, role }, isNewUser }`.
- Errors mirror `/api/auth/tma`: `{ ok: false, error }` JSON.

### 5. tRPC — `src/server/trpc/root.ts`

- `session.logout` (protectedProcedure): `clearSessionCookie()` (web site needs logout).
- `wallets.list` (protectedProcedure): linked wallets for the user.
- `wallets.linkStart` (protectedProcedure): returns the challenge (`purpose: "link"`) — same `issueChallenge`.
- `wallets.linkVerify` (protectedProcedure): input `{ signedChallengeXdr }`; verify with `purpose = "link"`; `linkWallet(ctx.user.id, verifiedPublicKey)`.
- `wallets.unlink` (protectedProcedure): input `{ publicKey }`.

Linking goes through tRPC (authenticated internal API), login through route handlers (unauthenticated external entry) — consistent with AGENTS.md §Transport.

### 6. Payments — `src/services/payments.ts`

- In `executePaymentUnlocked` P2P branch (`recipientUserId`): if `getStellarAccountSecret(recipient)` throws (no custodial account), fall back to a verified `wallet_links` row for that user → destination = linked wallet, treated like the external path for balance/contact bookkeeping (no `applyBalanceDelta` credit, no `upsertContact`). If neither → `PaymentError` with a distinct code (e.g. `RECIPIENT_NOT_ACTIVE`) the UI translates to "recipient hasn't activated their wallet yet".
- `src/services/recipients.ts`: include a per-recipient flag (e.g. `paysToExternal`) so the picker can hint that the gift lands in the recipient's external wallet.

### 7. Frontend

- `pnpm add @stellar/freighter-api`.
- `src/components/web-login.tsx` (client): sign-in button → `requestAccess()` / `getActivePublicKey()` → POST challenge → `signTransaction(challengeXdr, { networkPassphrase })` → POST verify → refetch `wallet.get`. Handle: Freighter not installed (link to freighter.app), user rejected, network mismatch. RTL, next-intl strings.
- `src/components/onboarding-gate.tsx`: when no `initData` and not inside the Telegram WebView, render `WebLogin` instead of the current "openInTelegram" error.
- `src/app/[locale]/wallets/page.tsx` + nav link (alongside buy/send): list linked wallets (address, verified date), Add Wallet (linkStart/linkVerify Freighter flow), Remove (with last-auth-method guard), plus the TAK contract address and a hint that Freighter users must add the TAK contract to see balances.
- `src/components/external-send.tsx`: prefill the address field from the first linked wallet.
- Add all new strings to `messages/fa.json` and `messages/en.json`.

### 8. Docs

- `ARCHITECTURE.md`: §5 identity model (web-only users, `wallet_links`), §6 new tables, §7 new flow (web sign-in), §8.2 new routes, §10 security (SEP-10, proof-of-ownership, single-use challenges), §12 env `SEP10_SIGNING_KEY`.
- `README.md`: mention the web login path if the features list enumerates auth methods.

## Security notes

- Identity is the challenge's source account from `readChallengeTx`, never a client-supplied claim; verify signatures against that address only.
- Linking requires proof of ownership (the same SEP-10 challenge signed by the wallet) — prevents attaching someone else's public key.
- Challenges are single-use (nonce memo + `auth_challenges` row consumed atomically), 5-minute TTL, rate-limited.
- Challenges/links rejected for custodial addresses (server-controlled keys).
- Unlink guard: a web-only user cannot remove their last wallet.
- Duplicate link attempt → explicit conflict error.

## Failure modes

- Freighter absent or on mobile → clear "install Freighter (desktop extension)" CTA; the protocol is SEP-10-generic so Albedo/Lobstr/xBull buttons can be added later without backend changes.
- Expired/used challenge → clear error + re-issue.
- Web user with no custodial account taps Buy/Send → surface an activation CTA that calls the existing `ensureStellarAccount` + `retryAccountFunding` before/at first in-app transaction.
- P2P send to an inactive user → distinct error code, no money movement.
- Telegram MiniApp flow must remain unchanged (regression-check `/api/auth/tma`).

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- New unit tests (`src/services/__tests__/auth-stellar.test.ts`): happy-path challenge/verify; wrong-signer rejection; replay (second verify) rejection; expired rejection; purpose mismatch; link duplicate conflict; unlink last-method guard; `resolveStellarLogin` for new and existing users.
- Integration: route handlers against Stellar testnet (real challenge signed by a fresh Keypair); P2P to a linked-wallet-only user.
- Manual (dev browser + Freighter on testnet): sign in as a new web user, link/unlink wallets, withdraw with prefilled address; confirm the Telegram MiniApp login still works.
