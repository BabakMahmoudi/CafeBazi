import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import { getCachedBalance, syncBalanceFromChain } from "@/services/wallet";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  stellar: {
    getAccountBalance: vi.fn(async () => 42n),
  },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/stellar", () => h.stellar);

function seedDb(overrides: {
  stellarAccounts?: Array<Record<string, unknown>>;
  balances?: Array<Record<string, unknown>>;
} = {}) {
  return createFakeDb({
    users: [{ id: "u1", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" }],
    stellar_accounts: overrides.stellarAccounts ?? [
      { id: "sa1", userId: "u1", publicKey: "GA-USER", encryptedSecret: "enc", status: "active" },
    ],
    balances: overrides.balances ?? [{ id: "b1", userId: "u1", amount: "10" }],
  });
}

describe("wallet service — chain balance sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
  });

  it("replaces the cached balance with the on-chain TAK balance", async () => {
    const result = await syncBalanceFromChain("u1");

    expect(result.balance).toBe(42n);
    expect(h.stellar.getAccountBalance).toHaveBeenCalledWith("GA-USER");
    expect(h.db.tables().balances[0].amount).toBe("42");
  });

  it("creates a balances row when none exists", async () => {
    h.db = seedDb({ balances: [] });

    const result = await syncBalanceFromChain("u1");

    expect(result.balance).toBe(42n);
    const balance = h.db.tables().balances[0];
    expect(balance.userId).toBe("u1");
    expect(balance.amount).toBe("42");
  });

  it("leaves the cached balance untouched when the account is not active", async () => {
    h.db = seedDb({
      stellarAccounts: [
        { id: "sa1", userId: "u1", publicKey: "GA-USER", encryptedSecret: "enc", status: "pending_funding" },
      ],
    });

    const result = await syncBalanceFromChain("u1");

    expect(result.balance).toBe(10n);
    expect(h.stellar.getAccountBalance).not.toHaveBeenCalled();
    expect(h.db.tables().balances[0].amount).toBe("10");
  });

  it("keeps the cached balance when the user has no stellar account", async () => {
    h.db = seedDb({ stellarAccounts: [] });

    const result = await syncBalanceFromChain("u1");

    expect(result.balance).toBe(10n);
    expect(h.stellar.getAccountBalance).not.toHaveBeenCalled();
  });

  it("getCachedBalance reads the stored row", async () => {
    expect(await getCachedBalance("u1")).toBe(10n);
  });
});
