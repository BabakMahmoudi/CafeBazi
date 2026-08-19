import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory, typedErrorCode } from "@/server/trpc/middleware";
import { appRouter } from "@/server/trpc/root";
import type { Context, SessionUser } from "@/server/trpc/context";
import { GameError } from "@/services/games";

const h = vi.hoisted(() => ({
  games: {
    createGameSession: vi.fn(async (_userId: string) => ({
      sessionId: "s1",
      nonce: "nonce-1",
      hmac: "hmac-1",
      expiresAt: new Date(),
      freeSpinsRemaining: 1,
      paidSpinCost: 1n,
      paidSpinsRemaining: 10,
    })),
    spinRoulette: vi.fn(async () => ({
      outcome: { position: 0, emoji: "🥀", prize: 0n, labelKey: "burnt" },
      freeSpinsRemaining: 0,
      paidSpinsRemaining: 10,
      balance: 10n,
    })),
  },
}));

vi.mock("@/services/games", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/games")>();
  return {
    ...actual,
    createGameSession: h.games.createGameSession,
    spinRoulette: h.games.spinRoulette,
  };
});

const createCaller = createCallerFactory(appRouter);

function ctxWith(user: SessionUser | null): Context {
  return { user };
}

const member: SessionUser = { id: "u1", telegramId: "1", role: "member" };

describe("games tRPC router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects games.session without a session", async () => {
    const caller = createCaller(ctxWith(null));

    await expect(caller.games.session()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(h.games.createGameSession).not.toHaveBeenCalled();
  });

  it("creates a session for an authenticated member", async () => {
    const caller = createCaller(ctxWith(member));

    const result = await caller.games.session();

    expect(h.games.createGameSession).toHaveBeenCalledWith("u1");
    expect(result).toMatchObject({ sessionId: "s1", freeSpinsRemaining: 1 });
  });

  it("rejects games.spin without a session", async () => {
    const caller = createCaller(ctxWith(null));

    await expect(
      caller.games.spin({ sessionId: "s1", nonce: "n", hmac: "h", spinType: "free" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(h.games.spinRoulette).not.toHaveBeenCalled();
  });

  it("rejects invalid games.spin input", async () => {
    const caller = createCaller(ctxWith(member));

    await expect(
      caller.games.spin({ sessionId: "", nonce: "n", hmac: "h", spinType: "free" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.games.spin({ sessionId: "s", nonce: "", hmac: "h", spinType: "free" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.games.spin({ sessionId: "s", nonce: "n", hmac: "h", spinType: "cheat" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.games.spinRoulette).not.toHaveBeenCalled();
  });

  it("forwards spin input with the session user id", async () => {
    const caller = createCaller(ctxWith(member));

    await caller.games.spin({ sessionId: "s1", nonce: "nonce-1", hmac: "hmac-1", spinType: "paid" });

    expect(h.games.spinRoulette).toHaveBeenCalledWith({
      userId: "u1",
      sessionId: "s1",
      nonce: "nonce-1",
      hmac: "hmac-1",
      spinType: "paid",
    });
  });

  it("maps GameError codes to typed error codes", () => {
    expect(typedErrorCode(new GameError("no spins", "RATE_LIMIT"))).toBe("RATE_LIMIT");
    expect(typedErrorCode(new GameError("pool down", "POOL_UNAVAILABLE"))).toBe("POOL_UNAVAILABLE");
    expect(typedErrorCode(new Error("plain"))).toBeUndefined();
  });

  it("wraps GameError as the cause of a TRPC error", async () => {
    h.games.spinRoulette.mockRejectedValueOnce(new GameError("no spins left", "RATE_LIMIT"));
    const caller = createCaller(ctxWith(member));

    const error = await caller
      .games.spin({ sessionId: "s1", nonce: "n", hmac: "h", spinType: "free" })
      .catch((e: unknown) => e);

    expect((error as { code?: string }).code).toBe("INTERNAL_SERVER_ERROR");
    const cause = (error as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(GameError);
    expect((cause as GameError).code).toBe("RATE_LIMIT");
  });
});
