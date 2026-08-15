import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import { encryptSecret } from "@/lib/crypto";
import { ensureStellarAccount, retryAccountFunding } from "@/services/users";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  stellar: {
    generateKeypair: vi.fn(async () => ({ publicKey: "GA-NEW", secretKey: "SA-NEW" })),
    createFundedAccount: vi.fn(async () => undefined),
    addTrustline: vi.fn(async () => ({ envelopeXdr: "AAAA-TRUSTLINE", txHash: "trustline-hash" })),
    submitEnvelope: vi.fn(async () => "trustline-hash"),
    getIssuerPublicKey: vi.fn(() => "G-ISSUER"),
  },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/stellar", () => h.stellar);

const SA_OLD = "SA-OLD-SECRET";

function seedDb(overrides: { stellarAccounts?: Array<Record<string, unknown>> } = {}) {
  return createFakeDb({
    users: [{ id: "u1", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" }],
    stellar_accounts: overrides.stellarAccounts ?? [],
  });
}

describe("users service — Stellar account onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
  });

  it("funds the account and submits the signed TAK trustline before marking it active", async () => {
    const result = await ensureStellarAccount("u1");

    expect(result.status).toBe("active");
    expect(h.stellar.createFundedAccount).toHaveBeenCalledWith("GA-NEW");
    expect(h.stellar.addTrustline).toHaveBeenCalledWith({
      sourceSecretKey: "SA-NEW",
      issuerPublicKey: "G-ISSUER",
    });
    expect(h.stellar.submitEnvelope).toHaveBeenCalledWith("AAAA-TRUSTLINE");
    expect(h.db.tables().stellar_accounts[0]).toMatchObject({
      userId: "u1",
      publicKey: "GA-NEW",
      status: "active",
    });
  });

  it("stores the account as pending_funding when the trustline cannot be submitted", async () => {
    h.stellar.submitEnvelope.mockRejectedValueOnce(new Error("horizon down"));

    const result = await ensureStellarAccount("u1");

    expect(result.status).toBe("pending_funding");
    expect(h.db.tables().stellar_accounts[0]).toMatchObject({
      userId: "u1",
      publicKey: "GA-NEW",
      status: "pending_funding",
    });
  });

  it("re-submits the trustline when retrying a pending_funding account", async () => {
    h.db = seedDb({
      stellarAccounts: [
        {
          id: "sa1",
          userId: "u1",
          publicKey: "GA-OLD",
          encryptedSecret: encryptSecret(SA_OLD),
          status: "pending_funding",
        },
      ],
    });

    const result = await retryAccountFunding("u1");

    expect(result.status).toBe("active");
    expect(h.stellar.createFundedAccount).toHaveBeenCalledWith("GA-OLD");
    expect(h.stellar.addTrustline).toHaveBeenCalledWith({
      sourceSecretKey: SA_OLD,
      issuerPublicKey: "G-ISSUER",
    });
    expect(h.stellar.submitEnvelope).toHaveBeenCalledWith("AAAA-TRUSTLINE");
    expect(h.db.tables().stellar_accounts[0].status).toBe("active");
  });

  it("leaves an active account untouched on retry", async () => {
    h.db = seedDb({
      stellarAccounts: [
        {
          id: "sa1",
          userId: "u1",
          publicKey: "GA-OLD",
          encryptedSecret: encryptSecret(SA_OLD),
          status: "active",
        },
      ],
    });

    const result = await retryAccountFunding("u1");

    expect(result.status).toBe("active");
    expect(h.stellar.addTrustline).not.toHaveBeenCalled();
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });
});
