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
    generateKeypair: vi.fn(async () => ({ publicKey: "GA-LAZY", secretKey: "SA-LAZY" })),
    createFundedAccount: vi.fn(),
    getNetworkPassphrase: vi.fn(async () => "Test SDF Network ; September 2015"),
    isValidStellarAddress: vi.fn(async (address: string) => address.startsWith("G")),
  },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/stellar", () => h.stellar);

const SECRET = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASECRET";

type SeedOverrides = {
  senderBalance?: string;
  senderAccountStatus?: string;
  transactions?: Array<Record<string, unknown>>;
  stellarAccounts?: Array<Record<string, unknown>>;
  walletLinks?: Array<Record<string, unknown>>;
};

function seedDb(overrides: SeedOverrides = {}) {
  return createFakeDb(
    {
      users: [
        { id: "sender", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" },
        { id: "recipient", telegramId: "200", telegramUsername: "reza", firstName: "Reza", role: "member" },
        { id: "merchant", telegramId: "300", telegramUsername: "shop", firstName: "Shop", role: "merchant" },
      ],
      stellar_accounts: overrides.stellarAccounts ?? [
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
      wallet_links: overrides.walletLinks ?? [],
    },
    { unique: { transactions: ["txHash"], wallet_links: ["publicKey"] } },
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

  it("sends to an external address as a withdrawal", async () => {
    const result = await executePayment({
      userId: "sender",
      destinationAddress: "GD-EXTERNAL",
      amount: 2n,
      type: "withdrawal",
      source: "miniapp",
    });

    expect(result.status).toBe("confirmed");
    expect(result.type).toBe("withdrawal");

    const tables = h.db.tables();
    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions[0]).toMatchObject({
      txHash: "txhash-1",
      type: "withdrawal",
      status: "confirmed",
      userId: "sender",
      fromAccount: "GA-SENDER",
      toAccount: "GD-EXTERNAL",
    });
    expect(tables.balances.find((b) => b.userId === "sender")?.amount).toBe("8");
    expect(tables.balances).toHaveLength(1);
    expect(tables.contacts).toHaveLength(0);
    expect(tables.audit_log[0]).toMatchObject({
      action: "payment.withdrawal",
      entity: "transactions",
    });
    expect(tables.audit_log[0].metadata).toMatchObject({
      action: "withdrawal",
      amount: "2",
      destination: "GD-EXTERNAL",
      source: "miniapp",
      status: "confirmed",
    });

    expect(h.stellar.buildSignedPayment).toHaveBeenCalledWith({
      sourceSecretKey: SECRET,
      destination: "GD-EXTERNAL",
      amount: "2",
      memo: undefined,
    });
    expect(h.stellar.submitEnvelope).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed external address", async () => {
    await expect(
      executePayment({
        userId: "sender",
        destinationAddress: "NOT-A-STELLAR-ADDRESS",
        amount: 1n,
        type: "withdrawal",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS" });

    expect(h.db.tables().transactions).toHaveLength(0);
    expect(h.stellar.buildSignedPayment).not.toHaveBeenCalled();
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("rejects sending to the sender's own address", async () => {
    await expect(
      executePayment({
        userId: "sender",
        destinationAddress: "GA-SENDER",
        amount: 1n,
        type: "withdrawal",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "SELF_ADDRESS" });

    expect(h.db.tables().transactions).toHaveLength(0);
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("credits an app-user destination's cached balance without a contact row", async () => {
    const result = await executePayment({
      userId: "sender",
      destinationAddress: "GA-RECIPIENT",
      amount: 2n,
      type: "withdrawal",
      source: "miniapp",
    });

    expect(result.status).toBe("confirmed");

    const tables = h.db.tables();
    expect(tables.transactions[0]).toMatchObject({
      type: "withdrawal",
      fromAccount: "GA-SENDER",
      toAccount: "GA-RECIPIENT",
    });
    expect(tables.balances.find((b) => b.userId === "recipient")?.amount).toBe("2");
    expect(tables.balances.find((b) => b.userId === "sender")?.amount).toBe("8");
    expect(tables.contacts).toHaveLength(0);
  });

  it("counts withdrawals toward the daily send cap", async () => {
    h.db = seedDb({
      transactions: [
        {
          id: "t-cap",
          txHash: "h-cap",
          userId: "sender",
          type: "withdrawal",
          status: "confirmed",
          amount: "50",
          createdAt: new Date(),
        },
      ],
    });

    await expect(
      executePayment({
        userId: "sender",
        destinationAddress: "GD-EXTERNAL",
        amount: 1n,
        type: "withdrawal",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });

    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
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

  it("lazily provisions a custodial account for a web-only sender", async () => {
    h.db = seedDb({
      stellarAccounts: [
        { id: "sa2", userId: "recipient", publicKey: "GA-RECIPIENT", encryptedSecret: encryptSecret(SECRET), status: "active" },
        { id: "sa3", userId: "merchant", publicKey: "GA-MERCHANT", encryptedSecret: encryptSecret(SECRET), status: "active" },
      ],
    });

    const result = await executePayment({
      userId: "sender",
      recipientUserId: "recipient",
      amount: 1n,
      type: "p2p",
      source: "miniapp",
    });

    expect(result.status).toBe("confirmed");
    const tables = h.db.tables();
    const senderAccount = tables.stellar_accounts.find((a) => a.userId === "sender");
    expect(senderAccount).toBeDefined();
    expect(senderAccount?.status).toBe("active");
    expect(tables.transactions[0]).toMatchObject({
      fromAccount: senderAccount?.publicKey,
      toAccount: "GA-RECIPIENT",
    });
    expect(h.stellar.createFundedAccount).toHaveBeenCalledWith(senderAccount?.publicKey);
  });

  it("throws ACCOUNT_NOT_READY when the sender's account cannot be funded", async () => {
    h.db = seedDb({ senderAccountStatus: "pending_funding" });
    h.stellar.createFundedAccount.mockRejectedValueOnce(new Error("testnet only"));

    await expect(
      executePayment({
        userId: "sender",
        recipientUserId: "recipient",
        amount: 1n,
        type: "p2p",
        source: "miniapp",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_READY" });

    expect(h.stellar.buildSignedPayment).not.toHaveBeenCalled();
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("pays a linked external wallet when the recipient has no custodial account", async () => {
    h.db = seedDb({
      stellarAccounts: [
        { id: "sa1", userId: "sender", publicKey: "GA-SENDER", encryptedSecret: encryptSecret(SECRET), status: "active" },
        { id: "sa3", userId: "merchant", publicKey: "GA-MERCHANT", encryptedSecret: encryptSecret(SECRET), status: "active" },
      ],
      walletLinks: [
        { id: "wl1", userId: "recipient", publicKey: "GA-LINKED-WALLET", source: "stellar", verifiedAt: new Date() },
      ],
    });

    const result = await executePayment({
      userId: "sender",
      recipientUserId: "recipient",
      amount: 2n,
      type: "p2p",
      source: "miniapp",
      memo: "نوش جان",
    });

    expect(result.status).toBe("confirmed");
    const tables = h.db.tables();
    expect(tables.transactions[0]).toMatchObject({
      type: "p2p",
      status: "confirmed",
      fromAccount: "GA-SENDER",
      toAccount: "GA-LINKED-WALLET",
      userId: "sender",
    });
    expect(tables.balances.find((b) => b.userId === "sender")?.amount).toBe("8");
    expect(tables.balances.find((b) => b.userId === "recipient")).toBeUndefined();
    expect(tables.contacts).toHaveLength(0);
    expect(tables.audit_log[0].metadata).toMatchObject({
      action: "p2p",
      recipient: "recipient",
      destination: "GA-LINKED-WALLET",
      status: "confirmed",
    });
    expect(h.stellar.buildSignedPayment).toHaveBeenCalledWith({
      sourceSecretKey: SECRET,
      destination: "GA-LINKED-WALLET",
      amount: "2",
      memo: "نوش جان",
    });
  });

  it("rejects a p2p send when the recipient has no custodial account and no linked wallet", async () => {
    h.db = seedDb({
      stellarAccounts: [
        { id: "sa1", userId: "sender", publicKey: "GA-SENDER", encryptedSecret: encryptSecret(SECRET), status: "active" },
        { id: "sa3", userId: "merchant", publicKey: "GA-MERCHANT", encryptedSecret: encryptSecret(SECRET), status: "active" },
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
    ).rejects.toMatchObject({ code: "RECIPIENT_NOT_ACTIVE" });

    expect(h.db.tables().transactions).toHaveLength(0);
    expect(h.stellar.buildSignedPayment).not.toHaveBeenCalled();
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
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
