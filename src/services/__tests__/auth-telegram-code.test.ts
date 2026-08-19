import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import {
  findTelegramLinkedUserByUsername,
  isTelegramAddressable,
  requestTelegramCode,
  verifyTelegramCode,
} from "@/services/auth-telegram-code";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  users: {
    getUserByUsername: vi.fn(async (_username: string) => null as unknown),
  },
  sendMessage: vi.fn(async (_input: { chatId: number | string; text: string }) => ({})),
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/users", () => h.users);
vi.mock("@/lib/telegram-api", () => ({ sendMessage: h.sendMessage }));

const telegramUser = {
  id: "u1",
  telegramId: "12345",
  telegramUsername: "ali",
  firstName: "Ali",
  role: "member",
};

function seedDb(overrides: {
  users?: Array<Record<string, unknown>>;
  telegramCodes?: Array<Record<string, unknown>>;
  auditLog?: Array<Record<string, unknown>>;
} = {}) {
  return createFakeDb(
    {
      users: overrides.users ?? [],
      telegram_codes: overrides.telegramCodes ?? [],
      audit_log: overrides.auditLog ?? [],
    },
    { unique: { users: ["telegramId", "telegramUsername"] } },
  );
}

function pendingCode(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    userId: "u1",
    codeHash: createHash("sha256").update("123456").digest("hex"),
    attempts: 0,
    status: "pending",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

describe("isTelegramAddressable", () => {
  it("accepts numeric telegram ids only", () => {
    expect(isTelegramAddressable({ telegramId: "12345" })).toBe(true);
    expect(isTelegramAddressable({ telegramId: "password-uuid" })).toBe(false);
    expect(isTelegramAddressable({ telegramId: "web-uuid" })).toBe(false);
    expect(isTelegramAddressable({ telegramId: "manual-uuid" })).toBe(false);
  });
});

describe("findTelegramLinkedUserByUsername", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.users.getUserByUsername.mockResolvedValue(null);
  });

  it("filters out non-numeric telegram ids", async () => {
    h.users.getUserByUsername.mockResolvedValueOnce({ ...telegramUser, telegramId: "password-1" });
    expect(await findTelegramLinkedUserByUsername("ALI")).toBeNull();

    h.users.getUserByUsername.mockResolvedValueOnce(telegramUser);
    expect(await findTelegramLinkedUserByUsername("ali")).toMatchObject({ id: "u1" });
  });

  it("normalizes the username before lookup", async () => {
    h.users.getUserByUsername.mockResolvedValueOnce(telegramUser);
    await findTelegramLinkedUserByUsername("  Ali ");
    expect(h.users.getUserByUsername).toHaveBeenCalledWith("ali");
  });
});

describe("requestTelegramCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
    h.users.getUserByUsername.mockResolvedValue(null);
  });

  it("returns NOT_FOUND for an unknown username without sending", async () => {
    await expect(requestTelegramCode({ username: "ghost" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a user with a non-numeric telegram id without sending", async () => {
    h.db = seedDb({
      users: [{ id: "u1", telegramId: "password-1", telegramUsername: "ali", firstName: "Ali", role: "member" }],
    });
    h.users.getUserByUsername.mockResolvedValue({
      ...telegramUser,
      telegramId: "password-1",
    });

    await expect(requestTelegramCode({ username: "ali" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("stores a SHA-256 hash and sends the code to the numeric chat id", async () => {
    h.db = seedDb({ users: [telegramUser] });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await requestTelegramCode({ username: "ali" });

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [sent] = h.sendMessage.mock.calls[0] as Array<{ chatId: number | string; text: string }>;
    expect(sent.chatId).toBe(12345);

    const code = /\d{6}/.exec(sent.text)?.[0];
    expect(code).toBeTruthy();
    const row = h.db.tables().telegram_codes.find((r) => r.userId === "u1");
    expect(row?.status).toBe("pending");
    expect(row?.codeHash).toBe(createHash("sha256").update(code!).digest("hex"));

    const audit = h.db.tables().audit_log.find((l) => l.action === "auth.code_requested");
    expect(audit).toMatchObject({ entityId: "u1" });
  });

  it("invalidates previous pending codes on a new request", async () => {
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [
        {
          id: "c1",
          userId: "u1",
          codeHash: "old",
          attempts: 0,
          status: "pending",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          createdAt: new Date(Date.now() - 2 * 60 * 1000),
        },
      ],
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await requestTelegramCode({ username: "ali" });

    const rows = h.db.tables().telegram_codes;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "c1")?.status).toBe("expired");
    expect(rows.find((r) => r.id !== "c1")?.status).toBe("pending");
  });

  it("rate-limits after 3 requests in 15 minutes", async () => {
    const now = Date.now();
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [0, 1, 2].map((i) => ({
        id: `c${i}`,
        userId: "u1",
        codeHash: `hash${i}`,
        attempts: 0,
        status: "used",
        expiresAt: new Date(now - 1000),
        createdAt: new Date(now - (i + 1) * 60 * 1000),
      })),
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await expect(requestTelegramCode({ username: "ali" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("blocks resend within the 60s cooldown", async () => {
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [
        pendingCode({ createdAt: new Date(Date.now() - 10 * 1000), codeHash: "h" }),
      ],
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await expect(requestTelegramCode({ username: "ali" })).rejects.toMatchObject({
      code: "RESEND_COOLDOWN",
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("maps a can't-initiate-conversation failure to BOT_NOT_STARTED and expires the fresh row", async () => {
    h.db = seedDb({ users: [telegramUser] });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);
    h.sendMessage.mockRejectedValueOnce(
      new Error("Telegram API sendMessage failed: Bad Request: can't initiate conversation with a user"),
    );

    await expect(requestTelegramCode({ username: "ali" })).rejects.toMatchObject({
      code: "BOT_NOT_STARTED",
    });

    const rows = h.db.tables().telegram_codes;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("expired");
  });

  it("maps a generic send failure to SEND_FAILED and expires the fresh row", async () => {
    h.db = seedDb({ users: [telegramUser] });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);
    h.sendMessage.mockRejectedValueOnce(new Error("Telegram API sendMessage failed: timeout"));

    await expect(requestTelegramCode({ username: "ali" })).rejects.toMatchObject({
      code: "SEND_FAILED",
    });

    expect(h.db.tables().telegram_codes[0].status).toBe("expired");
  });
});

describe("verifyTelegramCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
    h.users.getUserByUsername.mockResolvedValue(null);
  });

  it("returns INVALID_CODE for an unknown username", async () => {
    await expect(verifyTelegramCode({ username: "ghost", code: "123456" })).rejects.toMatchObject({
      code: "INVALID_CODE",
    });
  });

  it("marks a matching code used, sets consumed_at, and audits", async () => {
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [pendingCode()],
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    const { user } = await verifyTelegramCode({ username: "ali", code: " 123456 " });

    expect(user).toMatchObject({ id: "u1" });
    const row = h.db.tables().telegram_codes.find((r) => r.id === "c1");
    expect(row?.status).toBe("used");
    expect(row?.consumedAt).toBeInstanceOf(Date);
    const audit = h.db.tables().audit_log.find((l) => l.action === "auth.code_verified");
    expect(audit).toMatchObject({ entityId: "u1" });
  });

  it("increments attempts on a wrong code", async () => {
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [pendingCode()],
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await expect(verifyTelegramCode({ username: "ali", code: "000000" })).rejects.toMatchObject({
      code: "INVALID_CODE",
    });

    expect(h.db.tables().telegram_codes.find((r) => r.id === "c1")?.attempts).toBe(1);
  });

  it("locks the code at 5 wrong attempts", async () => {
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [pendingCode({ attempts: 4 })],
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await expect(verifyTelegramCode({ username: "ali", code: "000000" })).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
    });

    const row = h.db.tables().telegram_codes.find((r) => r.id === "c1");
    expect(row?.attempts).toBe(5);
    expect(row?.status).toBe("expired");
  });

  it("returns CODE_EXPIRED for an expired code", async () => {
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [
        pendingCode({ expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 11 * 60 * 1000) }),
      ],
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await expect(verifyTelegramCode({ username: "ali", code: "123456" })).rejects.toMatchObject({
      code: "CODE_EXPIRED",
    });

    expect(h.db.tables().telegram_codes.find((r) => r.id === "c1")?.status).toBe("expired");
  });

  it("returns INVALID_CODE for a used code", async () => {
    h.db = seedDb({
      users: [telegramUser],
      telegramCodes: [pendingCode({ status: "used" })],
    });
    h.users.getUserByUsername.mockResolvedValue(telegramUser);

    await expect(verifyTelegramCode({ username: "ali", code: "123456" })).rejects.toMatchObject({
      code: "INVALID_CODE",
    });
  });
});
