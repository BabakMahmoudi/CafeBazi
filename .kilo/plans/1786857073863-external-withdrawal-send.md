# Send TAK to an External Stellar Wallet (Freighter)

## Goal

Let a user send TAK from their in-app custodial account to any external Stellar address
(a wallet like Freighter that the app did **not** create). The server keeps custody and
signs; no secret key is ever exposed. This is a generalization of the existing
`payments.send` (P2P) flow: the destination is an arbitrary `G...` address instead of an
app user.

Freighter recipients need no trustline — TAK is a SEP-41 Soroban token, and contract
`transfer(from, to, i128)` works to any ed25519 address (balance is stored in the
contract, not via a trustline).

## Decisions

- New tRPC procedure `payments.sendExternal`, new transaction type `withdrawal`.
- External withdrawals count toward the **same** daily budget as p2p/gift/purchase
  (`DAILY_SEND_CAP` = 50 TAK, `DAILY_SEND_COUNT_LIMIT` = 20/day, confirmed by user).
- Destinations are restricted to ed25519 public keys (`G...`). `M...`/`C...` rejected.
- Sending to the sender's own address is rejected.
- If the destination matches an app user's active `stellar_accounts.public_key`, their
  cached `balances` row is credited on confirm (keeps the cache consistent, mirrors P2P).
  No contact upsert, no recipient history row (same as P2P today). For a
  pending_funding/disabled match, treat as external (no cache credit).
- UI: the `/send` page gets a tab toggle "To a user" | "To an external wallet".
  Client-side regex pre-validation (`^G[A-Z2-7]{55}$`) for immediate feedback; the
  server is authoritative.
- No DB migration: `transactions.type` is a plain `text` column (verified in
  `drizzle/meta/0000_snapshot.json`), and `TRANSACTION_TYPES` is a TS-level enum.
  Run `pnpm db:generate` to confirm zero diff; if it emits a no-op migration, discard it.

## Changes

### 1. `src/db/schema.ts`
- Add `"withdrawal"` to `TRANSACTION_TYPES` (after `"redemption"`, before `"lottery"`).

### 2. `src/services/stellar.ts`
- Add a lazy-SDK helper (mirrors the existing `sdk()` pattern, `server-only`):
  ```ts
  export async function isValidStellarAddress(address: string): Promise<boolean> {
    const s = await sdk();
    return s.StrKey.isValidEd25519PublicKey(address);
  }
  ```

### 3. `src/services/payments.ts`
- Add `destinationAddress?: string` to `ExecutePaymentInput`.
- Extend `PaymentError` codes with `"INVALID_ADDRESS"` and `"SELF_ADDRESS"`.
- In `executePaymentUnlocked`, add an external branch before the shop/recipient branches:
  - `if (input.destinationAddress)`:
    - `await isValidStellarAddress(...)`; on false → `PaymentError("Invalid destination address", "INVALID_ADDRESS")`.
    - if `input.destinationAddress === sender.publicKey` → `PaymentError("Cannot send to your own account", "SELF_ADDRESS")`.
    - `destinationPublicKey = input.destinationAddress`, `recipientUserId = undefined`, `shopId = null`.
    - Look up `stellarAccounts` by `public_key` (`eq(stellarAccounts.publicKey, destinationPublicKey)`).
      If a row exists with `status === "active"`, resolve `recipientUserId` for the cache credit.
- `checkRateLimits`: add `"withdrawal"` to the `inArray(transactions.type, [...])` list.
- On confirm: if `recipientUserId` was resolved (app-user destination), call
  `applyBalanceDelta(recipientUserId, null, input.amount)`; otherwise no recipient delta.
- Tx row: `type: "withdrawal"`, `toAccount: destinationPublicKey`, `userId: input.userId`.
- Audit entry: action `"payment.withdrawal"`, metadata
  `{ action: "withdrawal", amount: amountStr, destination, source, status }`.
- `dedupKey`/memo-preset logic stays chat-only; memo remains optional and DB-only
  (no on-chain memo in Soroban mode).

### 4. `src/server/trpc/root.ts`
- Add to `payments` router:
  ```ts
  sendExternal: protectedProcedure
    .input(z.object({
      address: z.string().trim().min(1).max(56),
      amount: amountSchema,
      memo: z.string().trim().max(100).optional(),
    }))
    .mutation(async ({ ctx, input }) =>
      executePayment({
        userId: ctx.user.id,
        destinationAddress: input.address,
        amount: input.amount,
        type: "withdrawal",
        source: "miniapp",
        memo: input.memo,
      }),
    ),
  ```
- Keep the procedure thin: `PaymentError` propagates as today (no new error formatter).
  The client pre-validates the address format and shows a generic error otherwise.

### 5. UI — `src/components/external-send.tsx` (new) + `src/components/send-cup.tsx`
- New `ExternalSend` component (same style as `SendCup`):
  - Address input (`G...`), cup count buttons `[1,2,3,5]`, optional memo.
  - Confirm button disabled until `cups >= 1` and `/^G[A-Z2-7]{55}$/.test(address)`.
  - Calls `trpc.payments.sendExternal`; shows `externalSuccess` on success,
    generic `error` on failure; clears the form on success.
- `SendCup`: add a two-tab switcher (state `"user" | "external"`) that renders the
  existing P2P form or `<ExternalSend />`.

### 6. i18n — `messages/fa.json` and `messages/en.json`
- `wallet.withdrawal`: «خروج» / "Withdrawal" (tx-history label).
- `send.tabToUser`: «به کاربر» / "To a user".
- `send.tabExternal`: «به کیف پول خارجی» / "To a wallet".
- `send.externalTitle`: «ارسال به کیف پول خارجی» / "Send to an external wallet".
- `send.externalAddress`: «آدرس کیف پول استلار» / "Stellar wallet address".
- `send.externalPlaceholder`: `G...` placeholder text.
- `send.externalHint`: «به هر کیف پول استلاری مثل Freighter ارسال کنید.» /
  "Send to any Stellar wallet, e.g. Freighter."
- `send.externalInvalid`: «آدرس نامعتبر است» / "Invalid address".
- `send.externalSuccess`: «به کیف پول خارجی ارسال شد ☕» / "Sent to the external wallet ☕".
- Reuse existing `send.confirm`, `send.error`, `send.memo`, `send.memoPlaceholder`.

### 7. `src/components/transactions-list.tsx`
- Add `withdrawal: "wallet.withdrawal"` to `TYPE_KEYS`.

### 8. Docs — `ARCHITECTURE.md`
- §6: add `withdrawal` to the `transactions.type` list in the data-model table.
- §8.1: add the `payments.sendExternal` row (mutation, JWT, "send TAK to an external
  Stellar address").
- Keep it to those two spots (single source of truth).

## Tests

`src/services/__tests__/payments.test.ts`:
- Extend the `h.stellar` mock with `isValidStellarAddress: vi.fn(async (a) => a.startsWith("G"))`.
- Add a `stellar_accounts` fixture or reuse existing rows for the app-user-destination case.
- New cases:
  1. Sends to an external address: `executePayment({ userId: "sender", destinationAddress: "GD-EXTERNAL", amount: 2n, type: "withdrawal", source: "miniapp" })` → confirmed; tx row `{ type: "withdrawal", fromAccount: "GA-SENDER", toAccount: "GD-EXTERNAL" }`; sender balance `10 → 8`; no shop/recipient balance rows touched; `buildSignedPayment` called with `destination: "GD-EXTERNAL", amount: "2"`; audit metadata `{ action: "withdrawal", destination: "GD-EXTERNAL", status: "confirmed" }`.
  2. Rejects a malformed address → `INVALID_ADDRESS`; `submitEnvelope` not called.
  3. Rejects sending to the sender's own address (`destinationAddress: "GA-SENDER"`) → `SELF_ADDRESS`.
  4. Credits the recipient's cached balance when the destination is an app user
     (`destinationAddress: "GA-RECIPIENT"`, seed `stellar_accounts` for `recipient`) →
     recipient balance credited, tx type `withdrawal`.
  5. Counts withdrawals toward the daily cap: seed a confirmed `withdrawal` tx of 50 TAK →
     next withdrawal rejects `RATE_LIMIT`.

`src/services/__tests__/stellar.test.ts` (if the existing fake-sdk harness permits):
- `isValidStellarAddress`: real `G...` key → true; `S...` secret / garbage → false.
  If the harness cannot load the real SDK, skip and rely on payments tests' mock.

## Validation

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm db:generate` → confirm no migration is produced (discard any no-op migration).
- `pnpm build`

## Out of scope / notes

- No key export, no import of external keys, no custody change (previous feature dropped).
- No new env vars.
- Recipient-side: an external wallet sees the TAK arrive on-chain; if it belongs to an
  app user whose account is `pending_funding`/`disabled`, their cache is not credited —
  on-chain is authoritative and `wallet.sync` reconciles.
- `M...` (muxed) and `C...` (contract) destinations are rejected for v1.
