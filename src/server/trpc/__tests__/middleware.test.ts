import { describe, expect, it } from "vitest";
import {
  adminProcedure,
  createCallerFactory,
  protectedProcedure,
  publicProcedure,
  router,
} from "@/server/trpc/middleware";
import type { Context, SessionUser } from "@/server/trpc/context";

const testRouter = router({
  ping: publicProcedure.query(() => "pong"),
  me: protectedProcedure.query(({ ctx }) => ctx.user.id),
  adminOnly: adminProcedure.query(({ ctx }) => ctx.user.role),
});

const createCaller = createCallerFactory(testRouter);

function ctxWith(user: SessionUser | null): Context {
  return { user };
}

const member: SessionUser = { id: "u1", telegramId: "1", role: "member" };
const admin: SessionUser = { id: "u2", telegramId: "2", role: "admin" };

describe("tRPC middleware", () => {
  it("allows public procedures without a session", async () => {
    const caller = createCaller(ctxWith(null));
    await expect(caller.ping()).resolves.toBe("pong");
  });

  it("rejects protected procedures without a session", async () => {
    const caller = createCaller(ctxWith(null));
    await expect(caller.me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows protected procedures for members", async () => {
    const caller = createCaller(ctxWith(member));
    await expect(caller.me()).resolves.toBe("u1");
  });

  it("rejects admin procedures for members", async () => {
    const caller = createCaller(ctxWith(member));
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows admin procedures for admins", async () => {
    const caller = createCaller(ctxWith(admin));
    await expect(caller.adminOnly()).resolves.toBe("admin");
  });
});
