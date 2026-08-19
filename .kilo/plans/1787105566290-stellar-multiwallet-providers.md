# Multi-wallet SEP-10 login/linking (Albedo + Freighter)

Goal: make the Stellar Web Authentication UI usable on phones by adding **Albedo** (browser popup wallet — works on desktop and mobile browsers, no install) alongside the existing **Freighter** (desktop extension). Inside the Telegram WebView the external-wallet UI is hidden and replaced with guidance, since extensions and popup return-paths do not work there. Backend is already SEP-10-generic — **no server changes**.

## Decisions (user-confirmed)

1. **Providers in v1:** Albedo (`@albedo-link/intent@0.13.0`) + Freighter (`@stellar/freighter-api`, already installed). Lobstr mobile-app flow is **deferred** (SDK package/API unverified; needs a real-device spike).
2. **In-MiniApp behavior:** when the app runs inside a real Telegram WebView (phone), hide provider buttons and show a hint to open the page in the phone's browser. Providers appear only in browser contexts (desktop browser or phone browser outside Telegram, including the dev mock).
3. Freighter stays desktop-extension-only; a missing extension keeps the current "install Freighter" CTA.

## Design

### 1. New client lib — `src/lib/wallet-providers.ts` (`"use client"`)

Single module owned by the UI; testable pure helpers.

- `type StellarWalletProvider = { id: "freighter" | "albedo"; getPublicKey(): Promise<string>; signChallenge(xdr: string, networkPassphrase: string): Promise<string>; }` — the caller (WebLogin/WalletsManager) owns the challenge/verify API calls and passes `purpose`.
- `freighterProvider`: `getPublicKey` = `requestAccess()` → `address`; `signChallenge` = `signTransaction(xdr, { networkPassphrase })` → `signedTxXdr`. Throw on `result.error`.
- `albedoProvider`: `getPublicKey` = `albedo.publicKey()` (returns `{ pubkey }` — **verify key name against package types at implementation time**); `signChallenge` = `albedo.sign({ type: "tx", xdr, network })` → `{ signed_transaction }`, where `network` comes from a passphrase→name map:
  ```ts
  const ALBEDO_NETWORKS: Record<string, "testnet" | "public"> = {
    "Test SDF Network ; September 2015": "testnet",
    "Public Global Stellar Network ; September 2015": "public",
  };
  ```
  Throw a clear "unsupported network" error if the passphrase is missing from the map.
- `isRealTelegramWebView(): boolean` = `Boolean(readInitData()) && !telegramMockState.mocked` — extract `readInitData()` (currently duplicated inside `onboarding-gate.tsx`) here; reuse `telegramMockState` from `./telegram-provider`.
- `getWalletProviders(): StellarWalletProvider[]` — returns `[freighterProvider, albedoProvider]`; always empty when `isRealTelegramWebView()` or `typeof window === "undefined"`.
- `isBrowserContext()` (same check, boolean) for the guidance-vs-buttons switch.
- Import `@albedo-link/intent` and `@stellar/freighter-api` statically; unit tests mock both modules.
- SSR-safe: every function guards `typeof window`.

### 2. Refactor `src/components/web-login.tsx`

- Generalize the existing Freighter-only `signIn` into `signInWith(provider)`:
  1. `provider.getPublicKey()` → address (catch → `rejected`, or `notInstalled` when the Freighter extension check fails).
  2. POST `/api/auth/stellar/challenge` `{ publicKey: address, purpose: "login" }` (unchanged).
  3. `provider.signChallenge(challengeXdr, networkPassphrase)`.
  4. POST `/api/auth/stellar/verify` `{ signedChallengeXdr, purpose: "login" }` (unchanged) → invalidate `wallet.get` + `session.role` → `onSuccess`.
- Keep the existing `LoginError` keys; add `notSupported` for the albedo-network map miss.
- Render one button per `getWalletProviders()` entry, labeled via new i18n keys (`webLogin.providers.freighter` / `webLogin.providers.albedo`).
- Freighter "not installed": keep the install link — detect `window.freighter` missing inside the freighter click path (as today). No providers → render nothing (guest state is already browser-only, so this should not happen).

### 3. Refactor `src/components/wallets-manager.tsx`

- Generalize `addWallet` into `linkWalletWith(provider)` using the existing `wallets.linkStart` → `provider.signChallenge` → `wallets.linkVerify` flow; keep the `typedCode` error mapping (`ALREADY_LINKED`, `CUSTODIAL_KEY`, `CHALLENGE_USED`/`CHALLENGE_EXPIRED`).
- `wallets.isPending` → loading (unchanged). Otherwise:
  - `isBrowserContext()` → list of linked wallets (unchanged) + one "Add wallet with <provider>" button per `getWalletProviders()`.
  - else (real TMA) → keep list/remove/logout, replace the add buttons with a guidance block: new i18n `wallets.phoneHint` + a button `wallets.openInBrowser` that calls `openLink(window.location.href, { tryExternal: true })` from `@telegram-apps/sdk-react`.
- TAK contract hint and logout stay as-is.

### 4. `src/components/onboarding-gate.tsx`

- Replace the local `readInitData` with the shared `isRealTelegramWebView()`/`readInitData()` from the new lib. Behavior unchanged: guest branch shows the Telegram button when `isRealTelegramWebView()`, otherwise `WebLogin`.

### 5. i18n — `messages/fa.json` + `messages/en.json`

- `webLogin`: `providers.freighter` ("ورود با Freighter" / "Sign in with Freighter"), `providers.albedo` ("ورود با آلبیدو" / "Sign in with Albedo"), `notSupported` ("این شبکه پشتیبانی نمی‌شود" / "This network is not supported"). Existing error keys unchanged.
- `wallets`: `addFreighter`, `addAlbedo` ("افزودن با Freighter/آلبیدو" / "Add with Freighter/Albedo"), `phoneHint` ("برای افزودن کیف پول خارجی، این صفحه را در مرورگر گوشی باز کنید" / "To add an external wallet, open this page in your phone's browser"), `openInBrowser` ("باز کردن در مرورگر" / "Open in browser").

### 6. Dependency

- `pnpm add @albedo-link/intent` (latest 0.13.0). Verify its TypeScript types before writing the provider (task 1).

### 7. Tests — `src/lib/__tests__/wallet-providers.test.ts` (new)

Follow the existing vitest + `vi.mock` pattern (`tests/setup.ts` already provides env; node environment).

- Mock `@albedo-link/intent` and `@stellar/freighter-api`; stub `window`/`telegramMockState`.
- `ALBEDO_NETWORKS` mapping: testnet + public passphrases → names; unknown passphrase → `notSupported`.
- `albedoProvider.signChallenge` returns `signed_transaction` and rejects on `{ error }`.
- `freighterProvider` rejects on `requestAccess` error.
- `getWalletProviders()`: empty when `isRealTelegramWebView()` is true or no `window`; non-empty in a browser context.
- `isRealTelegramWebView()`: true only when real initData present AND not mocked.

No changes to existing service tests; `src/services/auth-stellar.ts`, the two route handlers, and tRPC procedures are untouched (regression: `/api/auth/tma`, `/api/bot/webhook` unaffected).

### 8. Docs

- `ARCHITECTURE.md` §7.11: note multi-provider client (Freighter desktop extension + Albedo web intent; Lobstr deferred), and that the MiniApp WebView relies on Telegram auth with an open-in-browser path for wallet management.
- `README.md`: adjust the web-login feature bullet ("Freighter on desktop; Albedo on any browser; mobile users open in their browser").
- `AGENTS.md` conventions: unchanged.

## Task list (ordered)

1. `pnpm add @albedo-link/intent`; read its package types/README to confirm `publicKey()` and `sign({ type: "tx", ... })` result keys; adjust the provider code to the actual API.
2. Create `src/lib/wallet-providers.ts` (providers, network map, `readInitData`, `isRealTelegramWebView`, `getWalletProviders`, SSR guards).
3. Refactor `src/components/web-login.tsx` to provider-driven sign-in.
4. Refactor `src/components/wallets-manager.tsx` (provider-driven linking + TMA guidance + `openLink` CTA).
5. Update `src/components/onboarding-gate.tsx` to use the shared detection.
6. Add i18n strings to `messages/fa.json` and `messages/en.json`.
7. Add `src/lib/__tests__/wallet-providers.test.ts`.
8. Update `ARCHITECTURE.md` §7.11 and `README.md`.
9. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm exec next build`.

## Risks / caveats

- **Albedo popup return** is unreliable inside the Telegram WebView — hence providers are browser-only and the MiniApp shows the open-in-browser guidance. Popup blockers are mitigated by invoking on button click (existing pattern).
- **Albedo API surface** must be verified against the installed package (task 1); the plan's assumed intent params are the documented `type: "tx"` shape.
- **Lobstr** deliberately excluded from v1; revisit when its SDK package name and deep-link return are confirmed on a real device.
- Freighter remains desktop-only; no behavior regression (existing install CTA preserved).

## Validation

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm exec next build` all green.
- Manual (testnet): Freighter login/link on desktop Chrome; Albedo login/link in desktop Chrome without Freighter; Albedo in a phone browser; wallets page in a real TMA shows guidance + open-in-browser, Telegram login unchanged; dev mock still shows provider buttons.
