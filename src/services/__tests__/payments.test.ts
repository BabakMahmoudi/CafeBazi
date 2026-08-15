import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import { encryptSecret } from "@/lib/crypto";
import { executePayment, getPaymentStatus, PaymentError } from "@/services/payments";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  stellar: {
    buildSignedPayment: vi.fn(async () => ({ envelopeXdr: "AAAA", txHash: "txhash-1" })),
    submitEnvelope: vi.fn(async () => "txhash-1"),
    getTransactionStatus: vi.fn(async () => "confirmed" as const),
    getAccountBalance: vi.fn(async () => 100n),
    getIssuerPublicKey: vi.fn(() => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    generateKeypair: vi.fn(),
    createFundedAccount: vi.fn(),
    getNetworkPassphrase: vi.fn(async () => "Test SDF Network ; September 2015"),
  },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/stellar", () => h.stellar);

const SECRET = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASECRET";

type SeedOverrides = {
  senderBalance?: string;
  senderAccountStatus?: string;
  transactions?: Array<Record<string, unknown>>;
};

function seedDb(overrides: SeedOverrides = {}) {
  return createFakeDb(
    {
      users: [
        { id: "sender", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" },
        { id: "recipient", telegramId: "200", telegramUsername: "reza", firstName: "Reza", role: "member" },
        { id: "merchant", telegramId: "300", telegramUsername: "shop", firstName: "Shop", role: "merchant" },
      ],
      stellar_accounts: [
        { id: "sa1", userId: "sender", publicKey: "GA-SENDER", encryptedSecret: encryptSecret(SECRET), status: overrides.senderAccountStatus ?? "active" },
        { id: "sa2", userId: "recipient", publicKey: "GA-RECIPIENT", encryptedSecret: encryptSecret(SECRET), status: "active" },
        { id: "sa3", userId: "merchant", publicKey: "GA-MERCHANT", encryptedSecret: encryptSecret(SECRET), status: "active" },
      ],
      balances: [{ id: "b1", userId: "sender", amount: overrides.senderBalance ?? "10" }],
      coffee_shops: [
        { id: "shop1", merchantId: "merchant", slug: "1", name: "کافه مرکزی", isActive: true },
      ],
      transactions: overrides.transactions ?? [],
      contacts: [],
      audit_log: [],
    },
    { unique: { transactions: ["txHash"] } },
  );
}

describe("payments service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
  });

  it("confirms a purchase and updates balances + audit log", async () => {
    const result = await executePayment({
      userId: "sender",
      shopId: "shop1",
      amount: 2n,
      type: "purchase",
      source: "miniapp",
    });

    expect(result.status).toBe("confirmed");
    expect(result.type).toBe("purchase");

    const tables = h.db.tables();
    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions[0]).toMatchObject({
      txHash: "txhash-1",
      userId: "sender",
      shopId: "shop1",
      status: "confirmed",
      fromAccount: "GA-SENDER",
      toAccount: "GA-MERCHANT",
    });
    expect(tables.balances.find((b) => b.userId === "sender")?.amount).toBe("8");
    expect(tables.balances.find((b) => b.shopId === "shop1")?.amount).toBe("2");
    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0].metadata).toMatchObject({
      action: "purchase",
      cups: 2,
      shop: "shop1",
      source: "miniapp",
      status: "confirmed",
    });

    expect(h.stellar.buildSignedPayment).toHaveBeenCalledTimes(1);
    expect(h.stellar.submitEnvelope).toHaveBeenCalledTimes(1);
  });

  it("signs a contract transfer to the shop's account without a trustline", async () => {
    await executePayment({
      userId: "sender",
      shopId: "shop1",
      amount: 2n,
      type: "purchase",
      source: "miniapp",
    });

    expect(h.stellar.buildSignedPayment).toHaveBeenCalledWith({
      sourceSecretKey: SECRET,
      destination: "GA-MERCHANT",
      amount: "2",
      memo: undefined,
    });
  });

  it("signs a contract transfer to the recipient without a trustline", async () => {
    await executePayment({
      userId: "sender",
      recipientUserId: "recipient",
      amount: 1n,
      type: "p2p",
      source: "miniapp",
    });

    expect(h.stellar.buildSignedPayment).toHaveBeenCalledWith({
      sourceSecretKey: SECRET,
      destination: "GA-RECIPIENT",
      amount: "1",
      memo: undefined,
    });
  });

  it("rejects a payment when the cached balance is insufficient", async () => {
    h.db = seedDb({ senderBalance: "1" });

    await expect(
      executePayment({
        userId: "sender",
        shopId: "shop1",
        amount: 2n,
        type: "purchase",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });

    expect(h.db.tables().transactions).toHaveLength(0);
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a purchase for an inactive or missing shop", async () => {
    await expect(
      executePayment({
        userId: "sender",
        shopId: "missing-shop",
        amount: 1n,
        type: "purchase",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "SHOP_NOT_FOUND" });
  });

  it("rejects a p2p send to an unknown recipient", async () => {
    await expect(
      executePayment({
        userId: "sender",
        recipientUserId: "ghost",
        amount: 1n,
        type: "p2p",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "RECIPIENT_NOT_FOUND" });
  });

  it("is idempotent on duplicate tx_hash (insert-before-submit)", async () => {
    h.stellar.buildSignedPayment.mockResolvedValue({ envelopeXdr: "AAAA", txHash: "same-hash" });

    const first = await executePayment({
      userId: "sender",
      shopId: "shop1",
      amount: 1n,
      type: "purchase",
      source: "miniapp",
    });
    const second = await executePayment({
      userId: "sender",
      shopId: "shop1",
      amount: 1n,
      type: "purchase",
      source: "miniapp",
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("confirmed");
    expect(h.db.tables().transactions).toHaveLength(1);
    expect(h.stellar.submitEnvelope).toHaveBeenCalledTimes(1);
  });

  it("short-circuits duplicate chat callbacks via dedupKey", async () => {
    const first = await executePayment({
      userId: "sender",
      recipientUserId: "recipient",
      amount: 1n,
      type: "p2p",
      source: "chat",
      memo: "☕",
      dedupKey: "nonce-1",
    });
    const second = await executePayment({
      userId: "sender",
      recipientUserId: "recipient",
      amount: 1n,
      type: "p2p",
      source: "chat",
      memo: "☕",
      dedupKey: "nonce-1",
    });

    expect(first.status).toBe("confirmed");
    expect(second.id).toBe(first.id);
    expect(h.db.tables().transactions).toHaveLength(1);
    expect(h.stellar.buildSignedPayment).toHaveBeenCalledTimes(1);
    expect(h.stellar.submitEnvelope).toHaveBeenCalledTimes(1);
    expect(h.db.tables().transactions[0].memo).toBe("pay:nonce-1");
  });

  it("upserts a contact on a successful p2p transfer", async () => {
    await executePayment({
      userId: "sender",
      recipientUserId: "recipient",
      amount: 2n,
      type: "p2p",
      source: "miniapp",
      memo: "نوش جان",
    });

    const tables = h.db.tables();
    expect(tables.contacts).toHaveLength(1);
    expect(tables.contacts[0]).toMatchObject({
      userId: "sender",
      contactUserId: "recipient",
      source: "transfer",
    });
    expect(tables.balances.find((b) => b.userId === "recipient")?.amount).toBe("2");
    expect(tables.balances.find((b) => b.userId === "sender")?.amount).toBe("8");
  });

  it("enforces the daily send cap", async () => {
    h.db = seedDb({
      transactions: [
        {
          id: "t-old",
          txHash: "h-cap",
          userId: "sender",
          type: "p2p",
          status: "confirmed",
          amount: "50",
          createdAt: new Date(),
        },
      ],
    });

    await expect(
      executePayment({
        userId: "sender",
        recipientUserId: "recipient",
        amount: 1n,
        type: "p2p",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it("reconciles a stale submitted transaction on status read", async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    h.db = seedDb({
      transactions: [
        {
          id: "t-stuck",
          txHash: "h-stuck",
          userId: "sender",
          type: "p2p",
          status: "submitted",
          amount: "1",
          createdAt: old,
          updatedAt: old,
        },
      ],
    });
    h.stellar.getTransactionStatus.mockResolvedValue("confirmed");

    const payment = await getPaymentStatus("sender", "t-stuck");
    expect(payment?.status).toBe("confirmed");
    expect(h.db.tables().transactions[0].status).toBe("confirmed");
    expect(h.stellar.getTransactionStatus).toHaveBeenCalledWith("h-stuck");
  });

  it("does not reconcile a recent submitted transaction", async () => {
    h.db = seedDb({
      transactions: [
        {
          id: "t-fresh",
          txHash: "h-fresh",
          userId: "sender",
          type: "p2p",
          status: "submitted",
          amount: "1",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const payment = await getPaymentStatus("sender", "t-fresh");
    expect(payment?.status).toBe("submitted");
    expect(h.stellar.getTransactionStatus).not.toHaveBeenCalled();
  });

  it("returns null for a status of another user's transaction", async () => {
    const payment = await getPaymentStatus("recipient", "t-other");
    expect(payment).toBeNull();
  });

  it("throws a typed error when the sender has no active account", async () => {
    h.db = seedDb({ senderAccountStatus: "pending_funding" });

    await expect(
      executePayment({
        userId: "sender",
        recipientUserId: "recipient",
        amount: 1n,
        type: "p2p",
        source: "miniapp",
      }),
    ).rejects.toThrow("No active Stellar account");
  });

  it("rejects sending to yourself", async () => {
    await expect(
      executePayment({
        userId: "sender",
        recipientUserId: "sender",
        amount: 1n,
        type: "p2p",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "RECIPIENT_NOT_FOUND" });
  });

  it("exposes typed error codes", () => {
    const err = new PaymentError("no funds", "INSUFFICIENT_FUNDS");
    expect(err.code).toBe("INSUFFICIENT_FUNDS");
    expect(err.name).toBe("PaymentError");
  });
});
