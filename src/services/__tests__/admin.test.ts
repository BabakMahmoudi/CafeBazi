import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import { stellarAccounts } from "@/db/schema";
import {
  createUserForAdmin,
  listUsersForAdmin,
  syncUserBalanceForAdmin,
  updateUserForAdmin,
} from "@/services/admin";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  users: {
    ensureStellarAccount: vi.fn(
      async (
        _userId: string,
      ): Promise<{ status: "active" | "pending_funding"; publicKey: string }> => ({
        status: "active",
        publicKey: "GA-NEW",
      }),
    ),
  },
  wallet: {
    syncBalanceFromChain: vi.fn(async (_userId: string) => ({ balance: 7n, synced: true })),
  },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/users", () => h.users);
vi.mock("@/services/wallet", () => h.wallet);

function seedDb(overrides: {
  users?: Array<Record<string, unknown>>;
  stellarAccounts?: Array<Record<string, unknown>>;
  balances?: Array<Record<string, unknown>>;
  authCredentials?: Array<Record<string, unknown>>;
} = {}) {
  return createFakeDb(
    {
      users: overrides.users ?? [
        { id: "u1", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" },
        { id: "u2", telegramId: "200", telegramUsername: "admin", firstName: "Admin", role: "admin" },
      ],
      stellar_accounts: overrides.stellarAccounts ?? [
        { id: "sa1", userId: "u1", publicKey: "GA-U1", encryptedSecret: "enc", status: "active" },
      ],
      balances: overrides.balances ?? [{ id: "b1", userId: "u1", amount: "12" }],
      auth_credentials: overrides.authCredentials ?? [],
    },
    { unique: { users: ["telegramId"] } },
  );
}

describe("admin service — user management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
    h.users.ensureStellarAccount.mockImplementation(async (userId: string) => {
      await h.db
        .insert(stellarAccounts)
        .values({
          userId,
          publicKey: "GA-NEW",
          encryptedSecret: "enc",
          status: "active",
        })
        .returning();
      return { status: "active", publicKey: "GA-NEW" };
    });
  });

  describe("listUsersForAdmin", () => {
    it("merges the Stellar address and cached balance into the user view", async () => {
      const result = await listUsersForAdmin({});

      expect(result.items).toHaveLength(2);
      const ali = result.items.find((u) => u.id === "u1");
      expect(ali).toMatchObject({
        firstName: "Ali",
        telegramUsername: "ali",
        role: "member",
        publicKey: "GA-U1",
        accountStatus: "active",
      });
      expect(ali?.balance).toBe(12n);
      const admin = result.items.find((u) => u.id === "u2");
      expect(admin).toMatchObject({ publicKey: null, accountStatus: null });
      expect(admin?.balance).toBe(0n);
    });

    it("filters by first name / username via ILIKE", async () => {
      const result = await listUsersForAdmin({ query: "ali" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("u1");
    });

    it("respects limit and reports hasMore without offset support", async () => {
      const first = await listUsersForAdmin({ limit: 1, offset: 0 });
      expect(first.items).toHaveLength(1);
      expect(first.hasMore).toBe(true);

      const second = await listUsersForAdmin({ limit: 1, offset: 1 });
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
    });

    it("returns an empty page for an out-of-range offset", async () => {
      const result = await listUsersForAdmin({ limit: 50, offset: 100 });
      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("createUserForAdmin", () => {
    it("inserts the user plus a stellar account and a zero balance row", async () => {
      const created = await createUserForAdmin({
        firstName: "New",
        telegramId: "300",
        telegramUsername: "newbie",
        phone: "0912",
        role: "merchant",
      });

      expect(created.id).toBeTruthy();
      expect(created.publicKey).toBe("GA-NEW");
      expect(created.accountStatus).toBe("active");
      expect(created.balance).toBe(0n);
      expect(h.users.ensureStellarAccount).toHaveBeenCalledWith(created.id);

      const tables = h.db.tables();
      expect(tables.users).toHaveLength(3);
      expect(tables.users.find((u) => u.id === created.id)).toMatchObject({
        telegramId: "300",
        telegramUsername: "newbie",
        phone: "0912",
        firstName: "New",
        role: "merchant",
      });
      expect(tables.stellar_accounts).toHaveLength(2);
      expect(tables.balances.find((b) => b.userId === created.id)?.amount).toBe("0");
    });

    it("generates a manual telegramId placeholder when omitted", async () => {
      const created = await createUserForAdmin({ firstName: "NoTelegram", role: "member" });

      expect(created.telegramId).toMatch(/^manual-/);
      expect(h.db.tables().users.find((u) => u.id === created.id)?.telegramId).toMatch(/^manual-/);
    });

    it("reports CONFLICT on a duplicate telegramId", async () => {
      await expect(
        createUserForAdmin({ firstName: "Dup", telegramId: "100", role: "member" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("surfaces pending_funding when account funding fails", async () => {
      h.users.ensureStellarAccount.mockResolvedValueOnce({
        status: "pending_funding",
        publicKey: "GA-X",
      });

      const created = await createUserForAdmin({ firstName: "Pend", role: "member" });

      expect(created.accountStatus).toBe("pending_funding");
      expect(created.publicKey).toBe("GA-X");
    });
  });

  describe("updateUserForAdmin", () => {
    it("updates the editable fields and returns the refreshed view", async () => {
      const updated = await updateUserForAdmin({
        userId: "u1",
        actorUserId: "u2",
        firstName: "Ali R",
        phone: null,
        role: "merchant",
      });

      expect(updated).toMatchObject({ firstName: "Ali R", phone: null, role: "merchant" });
      expect(updated.balance).toBe(12n);
      expect(updated.publicKey).toBe("GA-U1");
      expect(h.db.tables().users.find((u) => u.id === "u1")).toMatchObject({
        firstName: "Ali R",
        phone: null,
        role: "merchant",
      });
    });

    it("rejects self-demotion", async () => {
      await expect(
        updateUserForAdmin({ userId: "u2", actorUserId: "u2", role: "member" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects demoting the last admin", async () => {
      await expect(
        updateUserForAdmin({ userId: "u2", actorUserId: "u1", role: "member" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("allows demoting an admin when another admin remains", async () => {
      h.db = seedDb({
        users: [
          { id: "u1", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "admin" },
          { id: "u2", telegramId: "200", telegramUsername: "admin", firstName: "Admin", role: "admin" },
        ],
      });

      const updated = await updateUserForAdmin({
        userId: "u2",
        actorUserId: "u1",
        role: "member",
      });

      expect(updated.role).toBe("member");
      expect(h.db.tables().users.find((u) => u.id === "u2")?.role).toBe("member");
    });

    it("throws NOT_FOUND for a missing user", async () => {
      await expect(
        updateUserForAdmin({ userId: "ghost", actorUserId: "u2", role: "member" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("syncs auth_credentials.username when a password user's handle is edited", async () => {
      h.db = seedDb({
        authCredentials: [
          {
            id: "ac1",
            userId: "u1",
            username: "ali",
            passwordHash: "scrypt$x",
            failedAttempts: 0,
            lockedUntil: null,
            passwordChangedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      const updated = await updateUserForAdmin({
        userId: "u1",
        actorUserId: "u2",
        telegramUsername: "AliNew",
      });

      expect(updated.telegramUsername).toBe("AliNew");
      expect(h.db.tables().users.find((u) => u.id === "u1")?.telegramUsername).toBe("AliNew");
      expect(h.db.tables().auth_credentials.find((c) => c.userId === "u1")?.username).toBe(
        "alinew",
      );
    });
  });

  describe("syncUserBalanceForAdmin", () => {
    it("delegates to syncBalanceFromChain", async () => {
      const result = await syncUserBalanceForAdmin("u1");

      expect(h.wallet.syncBalanceFromChain).toHaveBeenCalledWith("u1");
      expect(result).toEqual({ balance: 7n, synced: true });
    });
  });
});
