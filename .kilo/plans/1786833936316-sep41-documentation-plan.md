# Document TAK as a SEP-41 Soroban token contract

## Goal

The docs describe TAK as a "Soroban token contract" but never name the standard. TAK is a **SEP-41** (Stellar Token Interface) Soroban contract token — this has concrete coding effects that must be explicit so future agents don't break the money path. Update all project documents to say "SEP-41" wherever the TAK contract is described, and document the on-chain vs app-layer amount scaling.

## Context (verified in code)

- `src/services/stellar.ts:6` — `TAK_DECIMALS = 10n ** 7n` (SEP-41 convention: 7 decimals, same as XLM).
- `src/services/stellar.ts:59-97` — `buildSignedContractTransfer` invokes SEP-41 `transfer(from, to, i128)` on `env.TAK_CONTRACT_ID` via `Operation.invokeContractFunction`, simulate→assemble→sign over Soroban RPC. Active when `TAK_CONTRACT_ID` is set (line 107); classic trustline path is fallback only.
- `src/services/stellar.ts:271-293` — `getContractTakBalance` reads the SEP-41 `("Balance", address)` data key (`getContractData`, `scvI128`), converts i128→bigint→whole TAK via `TAK_DECIMALS`.
- `src/services/stellar.ts:196-223`, `227-248` — `submitEnvelope`/`getTransactionStatus` route Soroban txs via `rpc.Server.sendTransaction`/`getTransaction` (Horizon fallback for classic ops).
- Effects: no trustlines, no on-chain memos (memos only in `transactions.memo`), XLM reserve + Soroban fee float per account.

## Key facts to state in the docs

1. TAK is a SEP-41 Soroban token contract (`TAK_CONTRACT_ID`), not a classic trustline asset.
2. Payments are SEP-41 `transfer` contract invocations submitted via Soroban RPC; balances are read from the `("Balance", address)` data key.
3. On-chain amounts are `i128` scaled by `decimals = 7` (`TAK_DECIMALS = 10^7`); the app layer keeps **whole TAK as `bigint`** — conversion only in `src/services/stellar.ts`. This is compatible with the existing "no decimals / money is integer bigint" invariant, which refers to the app layer.
4. No trustlines; no on-chain memos.

## Edits

### 1. `ARCHITECTURE.md` (source of truth)

- §2 Constraints table, Stellar row: add "TAK is a SEP-41 Soroban token contract; payments/balances via Soroban RPC; Horizon for classic ops".
- §4 Tech stack, `@stellar/stellar-sdk` row: note it bundles the Soroban RPC client and SEP-41 contract support.
- §5.1 XLM reserves note: change "TAK is a Soroban token contract" → "TAK is a SEP-41 Soroban token contract".
- §5.2 Asset: reword to state TAK is a SEP-41 token contract (`TAK_CONTRACT_ID`), on-chain `i128` with `decimals = 7`, app layer uses whole-TAK `bigint`, no trustlines, no on-chain memos.
- §7.2 purchase flow: "TAK contract `transfer`" → "SEP-41 `transfer`".
- §7.8 P2P flow: "TAK contract `transfer`" → "SEP-41 `transfer`" (keep existing no-on-chain-memos note).
- §10 security: "against Soroban RPC" → add "(SEP-41)".
- §12 env vars table: `SOROBAN_RPC_URL` and `TAK_CONTRACT_ID` descriptions → mention SEP-41; clarify `TAK_CONTRACT_ID` activates contract mode and the classic trustline path is a fallback.

### 2. `README.md`

- Tech stack table, Blockchain row: "custom asset `TAK`" → "TAK as a SEP-41 Soroban token contract (no trustlines)".
- "How the coin works": add one bullet noting TAK lives in a SEP-41 token contract and transfers/balances go through Soroban RPC.
- Env var table: update `SOROBAN_RPC_URL` and `TAK_CONTRACT_ID` descriptions to mention SEP-41.

### 3. `deployment.md`

- §0 blocker #1: "the TAK Soroban token contract" → "the TAK SEP-41 Soroban token contract".
- §4.1 env var table: update `TAK_CONTRACT_ID` / `SOROBAN_RPC_URL` descriptions to mention SEP-41.

### 4. `AGENTS.md`

- Tech stack section: add one line — "TAK is a SEP-41 Soroban token contract; payments/balance reads use contract mode (`TAK_CONTRACT_ID` + `SOROBAN_RPC_URL`) with a classic trustline fallback; on-chain amounts are `i128 × 10^7`, app layer is whole-TAK `bigint`".
- Conventions section: append to the money invariant line that it refers to the app layer; on-chain conversion lives in `src/services/stellar.ts` (`TAK_DECIMALS`).

### 5. `.env.example`

- Add missing `SOROBAN_RPC_URL` and `TAK_CONTRACT_ID` entries (currently absent despite being documented in README/ARCHITECTURE/deployment and validated in `src/lib/env.ts`), with comments noting SEP-41 contract mode and testnet defaults.

## Validation

- Docs-only change; run `pnpm lint` (unaffected) and visually verify the markdown tables render (aligned pipes).
- Cross-check all three env-var tables (`README.md`, `ARCHITECTURE.md` §12, `deployment.md` §4.1, `.env.example`) stay consistent.
- No code, schema, or test changes.
