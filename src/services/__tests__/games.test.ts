import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import { gameSessions } from "@/db/schema";
import { env } from "@/lib/env";
import { encryptSecret } from "@/lib/crypto";
import {
  createGameSession,
  drawOutcome,
  FREE_SPINS_PER_DAY,
  FREE_WEIGHTS,
  GameError,
  PAID_SPINS_PER_DAY,
  PAID_WEIGHTS,
  spinRoulette,
  verifySessionHmac,
} from "@/services/games";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  crypto: { randomInt: vi.fn() },
  stellar: {
    buildSignedPayment: vi.fn(),
    submitEnvelope: vi.fn(),
    getTransactionStatus: vi.fn(async () => "confirmed" as const),
    getAccountBalance: vi.fn(),
    getIssuerPublicKey: vi.fn(() => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    generateKeypair: vi.fn(),
    createFundedAccount: vi.fn(),
    getNetworkPassphrase: vi.fn(async () => "Test SDF Network ; September 2015"),
    isValidStellarAddress: vi.fn(async () => true),
  },
  transferCount: { n: 0 },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/stellar", () => h.stellar);
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: h.crypto.randomInt };
});

const SECRET = "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASECRET";
const MEMBER_PUBLIC_KEY = "GA-PLAYER";

type SeedOverrides = {
  balances?: Array<Record<string, unknown>>;
  stellarAccounts?: Array<Record<string, unknown>>;
  transactions?: Array<Record<string, unknown>>;
  gameSessions?: Array<Record<string, unknown>>;
};

function paidEntry(index: number): Record<string, unknown> {
  return {
    id: `fe-${index}`,
    txHash: `fee-${index}`,
    userId: "player",
    type: "game_entry",
    status: "confirmed",
    amount: "1",
    createdAt: new Date(),
  };
}

function seedDb(overrides: SeedOverrides = {}) {
  return createFakeDb(
    {
      users: [
        { id: "player", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" },
      ],
      stellar_accounts: overrides.stellarAccounts ?? [
        { id: "sa1", userId: "player", publicKey: MEMBER_PUBLIC_KEY, encryptedSecret: encryptSecret(SECRET), status: "active" },
      ],
      balances: overrides.balances ?? [{ id: "b1", userId: "player", amount: "10" }],
      transactions: overrides.transactions ?? [],
      game_sessions: overrides.gameSessions ?? [],
      game_scores: [],
      audit_log: [],
    },
    { unique: { transactions: ["txHash"] } },
  );
}

describe("games service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.transferCount.n = 0;
    h.crypto.randomInt.mockImplementation(() => 0);
    h.stellar.getAccountBalance.mockImplementation(async () => 100n);
    h.stellar.buildSignedPayment.mockImplementation(async () => {
      h.transferCount.n += 1;
      return { envelopeXdr: `env-${h.transferCount.n}`, txHash: `txhash-${h.transferCount.n}` };
    });
    h.stellar.submitEnvelope.mockImplementation(async () => `txhash-${h.transferCount.n}`);
    h.db = seedDb();
  });

  it("issues an active session with remaining spin counters", async () => {
    const session = await createGameSession("player");

    expect(session).toMatchObject({
      freeSpinsRemaining: FREE_SPINS_PER_DAY,
      paidSpinCost: 1n,
      paidSpinsRemaining: PAID_SPINS_PER_DAY,
    });
    expect(session.hmac).toHaveLength(64);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const tables = h.db.tables();
    expect(tables.game_sessions).toHaveLength(1);
    expect(tables.game_sessions[0]).toMatchObject({
      userId: "player",
      game: "espresso_roulette",
      status: "active",
    });
  });

  it("throws RATE_LIMIT when both free and paid spins are exhausted", async () => {
    h.db = seedDb({
      gameSessions: Array.from({ length: FREE_SPINS_PER_DAY + PAID_SPINS_PER_DAY }, (_, i) => ({
        id: `s-${i}`,
        userId: "player",
        game: "espresso_roulette",
        nonce: `n-${i}`,
        hmac: `h-${i}`,
        status: "used",
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      })),
      transactions: Array.from({ length: PAID_SPINS_PER_DAY }, (_, i) => paidEntry(i)),
    });

    await expect(createGameSession("player")).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it("still issues a session when only the free spins are exhausted", async () => {
    h.db = seedDb({
      gameSessions: [
        {
          id: "s-used",
          userId: "player",
          game: "espresso_roulette",
          nonce: "n",
          hmac: "h",
          status: "used",
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
        },
      ],
    });

    const session = await createGameSession("player");
    expect(session.freeSpinsRemaining).toBe(0);
    expect(session.paidSpinsRemaining).toBe(PAID_SPINS_PER_DAY);
  });

  it("verifies a valid session HMAC and marks it used", async () => {
    const session = await createGameSession("player");

    await expect(
      verifySessionHmac({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
      }),
    ).resolves.toMatchObject({ id: session.sessionId });

    const tables = h.db.tables();
    expect(tables.game_sessions.find((row) => row.id === session.sessionId)?.status).toBe("used");
  });

  it("rejects a tampered session HMAC", async () => {
    const session = await createGameSession("player");

    await expect(
      verifySessionHmac({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects a wrong session nonce", async () => {
    const session = await createGameSession("player");

    await expect(
      verifySessionHmac({
        userId: "player",
        sessionId: session.sessionId,
        nonce: "forged",
        hmac: session.hmac,
      }),
    ).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects an expired session", async () => {
    const session = await createGameSession("player");
    await h.db
      .update(gameSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(gameSessions.id, session.sessionId));

    await expect(
      verifySessionHmac({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
      }),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("rejects a reused session", async () => {
    const session = await createGameSession("player");
    await verifySessionHmac({
      userId: "player",
      sessionId: session.sessionId,
      nonce: session.nonce,
      hmac: session.hmac,
    });

    await expect(
      verifySessionHmac({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
      }),
    ).rejects.toMatchObject({ code: "SESSION_USED" });
  });

  it("picks the expected slot at cumulative weight boundaries", () => {
    expect(FREE_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100);
    expect(PAID_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100);

    h.crypto.randomInt.mockReturnValue(19);
    expect(drawOutcome("free")).toMatchObject({ position: 0, prize: 0n, labelKey: "burnt" });

    h.crypto.randomInt.mockReturnValue(20);
    expect(drawOutcome("free")).toMatchObject({ position: 1, prize: 1n, labelKey: "cup" });

    h.crypto.randomInt.mockReturnValue(60);
    expect(drawOutcome("free")).toMatchObject({ position: 4, prize: 5n, labelKey: "jackpot" });

    h.crypto.randomInt.mockReturnValue(99);
    expect(drawOutcome("free")).toMatchObject({ position: 7, prize: 2n, labelKey: "double" });
  });

  it("records a free-spin miss without any transaction", async () => {
    const session = await createGameSession("player");

    const result = await spinRoulette({
      userId: "player",
      sessionId: session.sessionId,
      nonce: session.nonce,
      hmac: session.hmac,
      spinType: "free",
    });

    expect(result.outcome).toMatchObject({ position: 0, prize: 0n });
    expect(result.balance).toBe(10n);
    expect(result.freeSpinsRemaining).toBe(0);
    expect(result.paidSpinsRemaining).toBe(PAID_SPINS_PER_DAY);
    expect(result.feeTxHash).toBeUndefined();
    expect(result.prizeTxHash).toBeUndefined();

    const tables = h.db.tables();
    expect(tables.transactions).toHaveLength(0);
    expect(tables.balances.find((b) => b.userId === "player")?.amount).toBe("10");
    expect(tables.game_scores).toHaveLength(1);
    expect(tables.game_scores[0]).toMatchObject({
      userId: "player",
      gameSessionId: session.sessionId,
      score: 0,
    });
    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0].metadata).toMatchObject({
      game: "espresso_roulette",
      spinType: "free",
      position: 0,
      prize: 0,
    });
    expect(h.stellar.buildSignedPayment).not.toHaveBeenCalled();
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("credits a free-spin win without a fee", async () => {
    h.crypto.randomInt.mockReturnValue(60);
    const session = await createGameSession("player");

    const result = await spinRoulette({
      userId: "player",
      sessionId: session.sessionId,
      nonce: session.nonce,
      hmac: session.hmac,
      spinType: "free",
    });

    expect(result.outcome).toMatchObject({ position: 4, prize: 5n, labelKey: "jackpot" });
    expect(result.balance).toBe(15n);
    expect(result.freeSpinsRemaining).toBe(0);
    expect(result.paidSpinsRemaining).toBe(PAID_SPINS_PER_DAY);
    expect(result.feeTxHash).toBeUndefined();
    expect(result.prizeTxHash).toBe("txhash-1");

    const tables = h.db.tables();
    expect(tables.transactions).toHaveLength(1);
    expect(tables.transactions[0]).toMatchObject({
      type: "game_reward",
      status: "confirmed",
      amount: "5",
      fromAccount: env.GAME_POOL_PUBLIC_KEY,
      toAccount: MEMBER_PUBLIC_KEY,
      userId: "player",
    });
    expect(tables.balances.find((b) => b.userId === "player")?.amount).toBe("15");
    expect(tables.game_scores).toHaveLength(1);
    expect(tables.game_scores[0]).toMatchObject({
      userId: "player",
      gameSessionId: session.sessionId,
      score: 4,
    });
    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0]).toMatchObject({ action: "game.spin", entity: "game_scores" });
    expect(tables.audit_log[0].metadata).toMatchObject({
      game: "espresso_roulette",
      spinType: "free",
      position: 4,
      prize: 5,
      prizeTx: "txhash-1",
    });
    expect(h.stellar.buildSignedPayment).toHaveBeenCalledTimes(1);
    expect(h.stellar.buildSignedPayment).toHaveBeenCalledWith({
      sourceSecretKey: env.GAME_POOL_SECRET_KEY,
      destination: MEMBER_PUBLIC_KEY,
      amount: "5",
    });
    expect(h.stellar.submitEnvelope).toHaveBeenCalledTimes(1);
  });

  it("charges the entry fee then pays the prize for a paid spin", async () => {
    h.crypto.randomInt.mockReturnValue(55);
    const session = await createGameSession("player");

    const result = await spinRoulette({
      userId: "player",
      sessionId: session.sessionId,
      nonce: session.nonce,
      hmac: session.hmac,
      spinType: "paid",
    });

    expect(result.outcome).toMatchObject({ position: 4, prize: 5n });
    expect(result.balance).toBe(14n);
    expect(result.feeTxHash).toBe("txhash-1");
    expect(result.prizeTxHash).toBe("txhash-2");
    expect(result.freeSpinsRemaining).toBe(1);
    expect(result.paidSpinsRemaining).toBe(PAID_SPINS_PER_DAY - 1);

    const tables = h.db.tables();
    expect(tables.transactions).toHaveLength(2);
    expect(tables.transactions[0]).toMatchObject({
      type: "game_entry",
      status: "confirmed",
      amount: "1",
      fromAccount: MEMBER_PUBLIC_KEY,
      toAccount: env.GAME_POOL_PUBLIC_KEY,
      userId: "player",
    });
    expect(tables.transactions[1]).toMatchObject({
      type: "game_reward",
      status: "confirmed",
      amount: "5",
      fromAccount: env.GAME_POOL_PUBLIC_KEY,
      toAccount: MEMBER_PUBLIC_KEY,
      userId: "player",
    });
    expect(tables.balances.find((b) => b.userId === "player")?.amount).toBe("14");
    expect(tables.game_scores[0].score).toBe(4);
    expect(tables.audit_log[0].metadata).toMatchObject({
      spinType: "paid",
      position: 4,
      prize: 5,
      feeTx: "txhash-1",
      prizeTx: "txhash-2",
    });
    expect(h.stellar.buildSignedPayment).toHaveBeenCalledTimes(2);
    expect(h.stellar.buildSignedPayment).toHaveBeenNthCalledWith(1, {
      sourceSecretKey: SECRET,
      destination: env.GAME_POOL_PUBLIC_KEY,
      amount: "1",
    });
    expect(h.stellar.buildSignedPayment).toHaveBeenNthCalledWith(2, {
      sourceSecretKey: env.GAME_POOL_SECRET_KEY,
      destination: MEMBER_PUBLIC_KEY,
      amount: "5",
    });
    expect(h.stellar.submitEnvelope).toHaveBeenCalledTimes(2);
  });

  it("rejects a paid spin when the cached balance is insufficient", async () => {
    h.db = seedDb({ balances: [{ id: "b1", userId: "player", amount: "0" }] });
    const session = await createGameSession("player");

    await expect(
      spinRoulette({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
        spinType: "paid",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });

    expect(h.db.tables().transactions).toHaveLength(0);
    expect(h.stellar.buildSignedPayment).not.toHaveBeenCalled();
    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("rejects a paid spin when the on-chain balance is insufficient", async () => {
    h.stellar.getAccountBalance.mockResolvedValue(0n);
    const session = await createGameSession("player");

    await expect(
      spinRoulette({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
        spinType: "paid",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });

    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("enforces the daily free-spin cap at spin time", async () => {
    h.db = seedDb({
      gameSessions: [
        {
          id: "s-used",
          userId: "player",
          game: "espresso_roulette",
          nonce: "n",
          hmac: "h",
          status: "used",
          expiresAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
        },
      ],
    });
    const session = await createGameSession("player");

    await expect(
      spinRoulette({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
        spinType: "free",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });

    expect(h.stellar.submitEnvelope).not.toHaveBeenCalled();
  });

  it("enforces the daily paid-spin cap at spin time", async () => {
    h.db = seedDb({
      transactions: Array.from({ length: PAID_SPINS_PER_DAY }, (_, i) => paidEntry(i)),
    });
    const session = await createGameSession("player");

    await expect(
      spinRoulette({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
        spinType: "paid",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });

    expect(h.stellar.buildSignedPayment).not.toHaveBeenCalled();
  });

  it("refunds the entry fee when the prize transfer fails", async () => {
    h.crypto.randomInt.mockReturnValue(55);
    h.stellar.submitEnvelope
      .mockResolvedValueOnce("fee-submit")
      .mockRejectedValueOnce(new Error("prize failed"))
      .mockResolvedValueOnce("refund-submit");
    const session = await createGameSession("player");

    await expect(
      spinRoulette({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
        spinType: "paid",
      }),
    ).rejects.toMatchObject({ code: "POOL_UNAVAILABLE" });

    const tables = h.db.tables();
    expect(tables.transactions).toHaveLength(3);
    expect(tables.transactions[0]).toMatchObject({ type: "game_entry", status: "confirmed", amount: "1" });
    expect(tables.transactions[1]).toMatchObject({ type: "game_reward", status: "failed", amount: "5" });
    expect(tables.transactions[2]).toMatchObject({ type: "game_reward", status: "confirmed", amount: "1" });
    expect(tables.balances.find((b) => b.userId === "player")?.amount).toBe("10");
    expect(tables.audit_log).toHaveLength(0);
  });

  it("writes a needsRefund audit entry when both prize and refund fail", async () => {
    h.crypto.randomInt.mockReturnValue(55);
    h.stellar.submitEnvelope
      .mockResolvedValueOnce("fee-submit")
      .mockRejectedValueOnce(new Error("prize failed"))
      .mockRejectedValueOnce(new Error("refund failed"));
    const session = await createGameSession("player");

    await expect(
      spinRoulette({
        userId: "player",
        sessionId: session.sessionId,
        nonce: session.nonce,
        hmac: session.hmac,
        spinType: "paid",
      }),
    ).rejects.toMatchObject({ code: "POOL_UNAVAILABLE" });

    const tables = h.db.tables();
    expect(tables.transactions).toHaveLength(3);
    expect(tables.transactions[2].status).toBe("failed");
    const refundAudit = tables.audit_log.find((entry) => entry.action === "game.refund");
    expect(refundAudit).toBeDefined();
    expect(refundAudit?.metadata).toMatchObject({
      game: "espresso_roulette",
      spinType: "paid",
      position: 4,
      prize: 5,
      needsRefund: true,
    });
  });

  it("exposes typed error codes", () => {
    const err = new GameError("no spins", "RATE_LIMIT");
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.name).toBe("GameError");
  });
});
