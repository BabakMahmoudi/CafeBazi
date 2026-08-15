import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "@/server/trpc/middleware";
import { appRouter } from "@/server/trpc/root";
import type { Context, SessionUser } from "@/server/trpc/context";

const h = vi.hoisted(() => ({
  admin: {
    listUsersForAdmin: vi.fn(async () => ({ items: [], hasMore: false })),
    createUserForAdmin: vi.fn(async () => ({})),
    updateUserForAdmin: vi.fn(async () => ({})),
    syncUserBalanceForAdmin: vi.fn(async () => ({ balance: 0n, synced: false })),
  },
}));

vi.mock("@/services/admin", () => h.admin);

const createCaller = createCallerFactory(appRouter);

function ctxWith(user: SessionUser | null): Context {
  return { user };
}

const member: SessionUser = { id: "u1", telegramId: "1", role: "member" };
const admin: SessionUser = { id: "u2", telegramId: "2", role: "admin" };

describe("admin tRPC router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects admin.users.list for a member session", async () => {
    const caller = createCaller(ctxWith(member));

    await expect(caller.admin.users.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.admin.listUsersForAdmin).not.toHaveBeenCalled();
  });

  it("rejects admin.users.list without a session", async () => {
    const caller = createCaller(ctxWith(null));

    await expect(caller.admin.users.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("forwards the list input for an admin session", async () => {
    const caller = createCaller(ctxWith(admin));

    const result = await caller.admin.users.list({ query: "ali", limit: 10, offset: 20 });

    expect(h.admin.listUsersForAdmin).toHaveBeenCalledWith({ query: "ali", limit: 10, offset: 20 });
    expect(result).toEqual({ items: [], hasMore: false });
  });

  it("applies the list defaults when input is omitted", async () => {
    const caller = createCaller(ctxWith(admin));

    await caller.admin.users.list({});

    expect(h.admin.listUsersForAdmin).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it("rejects an empty firstName on admin.users.create", async () => {
    const caller = createCaller(ctxWith(admin));

    await expect(
      caller.admin.users.create({ firstName: "", role: "member" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.admin.createUserForAdmin).not.toHaveBeenCalled();
  });

  it("rejects a non-digit telegramId on admin.users.create", async () => {
    const caller = createCaller(ctxWith(admin));

    await expect(
      caller.admin.users.create({ firstName: "X", telegramId: "abc", role: "member" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("allows an omitted telegramId on create", async () => {
    const caller = createCaller(ctxWith(admin));

    await caller.admin.users.create({ firstName: "X", role: "member" });

    expect(h.admin.createUserForAdmin).toHaveBeenCalledWith({ firstName: "X", role: "member" });
  });

  it("passes the acting admin id to admin.users.update", async () => {
    const caller = createCaller(ctxWith(admin));

    await caller.admin.users.update({ userId: "u9", role: "member" });

    expect(h.admin.updateUserForAdmin).toHaveBeenCalledWith({
      userId: "u9",
      role: "member",
      actorUserId: "u2",
    });
  });

  it("forwards the userId to admin.users.syncBalance", async () => {
    const caller = createCaller(ctxWith(admin));

    const result = await caller.admin.users.syncBalance({ userId: "u1" });

    expect(h.admin.syncUserBalanceForAdmin).toHaveBeenCalledWith("u1");
    expect(result).toEqual({ balance: 0n, synced: false });
  });

  it("exposes the current role via session.role", async () => {
    const caller = createCaller(ctxWith(member));

    await expect(caller.session.role()).resolves.toBe("member");
  });
});
