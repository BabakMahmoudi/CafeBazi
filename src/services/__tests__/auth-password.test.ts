import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import { stellarAccounts } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import {
  AuthPasswordError,
  signinWithPassword,
  signupWithPassword,
} from "@/services/auth-password";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  users: {
    ensureStellarAccount: vi.fn(
      async (
        userId: string,
      ): Promise<{ status: "active" | "pending_funding"; publicKey: string }> => {
        await h.db
          .insert(stellarAccounts)
          .values({ userId, publicKey: "GA-PW", encryptedSecret: "enc", status: "active" })
          .returning();
        return { status: "active", publicKey: "GA-PW" };
      },
    ),
    getStellarAccountByUserId: vi.fn(async () => null),
  },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/users", () => h.users);

const PASSWORD = "coffee-strong-password";

function seedDb(overrides: {
  users?: Array<Record<string, unknown>>;
  authCredentials?: Array<Record<string, unknown>>;
  balances?: Array<Record<string, unknown>>;
  auditLog?: Array<Record<string, unknown>>;
} = {}) {
  return createFakeDb(
    {
      users: overrides.users ?? [],
      auth_credentials: overrides.authCredentials ?? [],
      balances: overrides.balances ?? [],
      stellar_accounts: [],
      audit_log: overrides.auditLog ?? [],
    },
    {
      unique: {
        users: ["telegramId", "telegramUsername"],
        auth_credentials: ["username", "userId"],
        balances: ["userId"],
      },
    },
  );
}

describe("auth-password service — signup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
  });

  it("creates a user, credential, zero balance, and an eager Stellar account", async () => {
    const { user, accountStatus } = await signupWithPassword({
      username: "Ali_Roaster",
      password: PASSWORD,
    });

    expect(accountStatus).toBe("active");
    expect(user.telegramId.startsWith("password-")).toBe(true);
    expect(user).toMatchObject({
      telegramUsername: "ali_roaster",
      firstName: "ali_roaster",
      role: "member",
    });

    const tables = h.db.tables();
    expect(tables.users.find((u) => u.id === user.id)).toMatchObject({
      telegramId: user.telegramId,
      telegramUsername: "ali_roaster",
    });

    const credential = tables.auth_credentials.find((c) => c.userId === user.id);
    expect(credential).toMatchObject({ username: "ali_roaster", failedAttempts: 0 });
    expect(String(credential?.passwordHash)).toMatch(/^scrypt\$/);

    expect(tables.balances.find((b) => b.userId === user.id)?.amount).toBe("0");
    expect(h.users.ensureStellarAccount).toHaveBeenCalledWith(user.id);

    const audit = tables.audit_log.find((l) => l.entityId === user.id);
    expect(audit).toMatchObject({ action: "auth.signup", entity: "users" });
  });

  it("normalizes username case and whitespace", async () => {
    const { user } = await signupWithPassword({ username: "  Ali_Roaster  ", password: PASSWORD });

    expect(user.telegramUsername).toBe("ali_roaster");
    expect(h.db.tables().auth_credentials.find((c) => c.userId === user.id)?.username).toBe(
      "ali_roaster",
    );
  });

  it("reports USERNAME_TAKEN when the credential username is already taken", async () => {
    h.db = seedDb({
      users: [
        { id: "u0", telegramId: "telegram-0", telegramUsername: null, firstName: "U", role: "member" },
      ],
      authCredentials: [
        {
          id: "ac1",
          userId: "u0",
          username: "sara1",
          passwordHash: "scrypt$x",
          failedAttempts: 0,
          lockedUntil: null,
          passwordChangedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    await expect(
      signupWithPassword({ username: "SARA1", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "USERNAME_TAKEN" });
  });

  it("reports USERNAME_TAKEN when the users handle collides with a Telegram user", async () => {
    h.db = seedDb({
      users: [
        { id: "u1", telegramId: "100", telegramUsername: "ali_r", firstName: "Ali", role: "member" },
      ],
    });

    await expect(
      signupWithPassword({ username: "ALI_R", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "USERNAME_TAKEN" });
  });

  it("rejects a weak password", async () => {
    await expect(
      signupWithPassword({ username: "newbie", password: "short" }),
    ).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
  });

  it("rejects an invalid username format", async () => {
    await expect(
      signupWithPassword({ username: "a b c", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_USERNAME" });
  });

  it("surfaces pending_funding when account funding fails", async () => {
    h.users.ensureStellarAccount.mockResolvedValueOnce({
      status: "pending_funding",
      publicKey: "GA-PW",
    });

    const { accountStatus } = await signupWithPassword({ username: "newbie", password: PASSWORD });

    expect(accountStatus).toBe("pending_funding");
  });
});

describe("auth-password service — signin", () => {
  let credentialHash = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    credentialHash = await hashPassword(PASSWORD);
    h.db = seedDb();
  });

  async function seedCredential(overrides: Record<string, unknown> = {}) {
    h.db = seedDb({
      users: [
        { id: "u1", telegramId: "password-1", telegramUsername: "sara1", firstName: "sara1", role: "member" },
      ],
      authCredentials: [
        {
          id: "ac1",
          userId: "u1",
          username: "sara1",
          passwordHash: credentialHash,
          failedAttempts: 0,
          lockedUntil: null,
          passwordChangedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...overrides,
        },
      ],
    });
  }

  it("returns the user and resets failed attempts on success", async () => {
    await seedCredential({ failedAttempts: 3 });

    const { user } = await signinWithPassword({ username: "sara1", password: PASSWORD });

    expect(user).toMatchObject({ id: "u1", telegramUsername: "sara1" });
    const credential = h.db.tables().auth_credentials.find((c) => c.id === "ac1");
    expect(credential?.failedAttempts).toBe(0);
    expect(credential?.lockedUntil).toBeNull();
  });

  it("increments failed attempts on a wrong password", async () => {
    await seedCredential();

    await expect(
      signinWithPassword({ username: "sara1", password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(h.db.tables().auth_credentials.find((c) => c.id === "ac1")?.failedAttempts).toBe(1);
  });

  it("locks the account on the 5th failed attempt", async () => {
    await seedCredential({ failedAttempts: 4 });

    await expect(
      signinWithPassword({ username: "sara1", password: "wrong-password" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const credential = h.db.tables().auth_credentials.find((c) => c.id === "ac1");
    expect(credential?.failedAttempts).toBe(0);
    expect(credential?.lockedUntil).toBeInstanceOf(Date);

    await expect(
      signinWithPassword({ username: "sara1", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LOCKED" });
  });

  it("clears the lock once the lockout window passes", async () => {
    await seedCredential({ lockedUntil: new Date(Date.now() - 1000) });

    const { user } = await signinWithPassword({ username: "sara1", password: PASSWORD });

    expect(user.id).toBe("u1");
  });

  it("returns INVALID_CREDENTIALS for an unknown username", async () => {
    await seedCredential();

    await expect(
      signinWithPassword({ username: "ghost", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("matches an uppercase username against a lowercase credential", async () => {
    await seedCredential();

    const { user } = await signinWithPassword({ username: "SARA1", password: PASSWORD });

    expect(user.id).toBe("u1");
  });
});

describe("auth-password service — typed errors", () => {
  it("exposes typed error codes", () => {
    const error = new AuthPasswordError("x", "USERNAME_TAKEN");

    expect(error.code).toBe("USERNAME_TAKEN");
  });
});
