import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import faMessages from "../../messages/fa.json";
import { db } from "@/db";
import { auditLog, telegramCodes } from "@/db/schema";
import { sendMessage } from "@/lib/telegram-api";
import { getUserByUsername, type OnboardedUser } from "@/services/users";

const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const REQUEST_COOLDOWN_MS = 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

const botMessages = faMessages.bot as { codeMessage: string };

export class TelegramCodeError extends Error {
  constructor(
    message: string,
    public code:
      | "NOT_FOUND"
      | "RATE_LIMITED"
      | "RESEND_COOLDOWN"
      | "BOT_NOT_STARTED"
      | "SEND_FAILED"
      | "INVALID_CODE"
      | "CODE_EXPIRED"
      | "TOO_MANY_ATTEMPTS"
      | "INTERNAL",
  ) {
    super(message);
    this.name = "TelegramCodeError";
  }
}

export function isTelegramAddressable(user: { telegramId: string }): boolean {
  return /^\d+$/.test(user.telegramId);
}

export async function findTelegramLinkedUserByUsername(
  raw: string,
): Promise<OnboardedUser | null> {
  const username = raw.trim().toLowerCase();
  const user = await getUserByUsername(username);
  if (!user || !isTelegramAddressable(user)) {
    return null;
  }
  return user;
}

function toEpoch(value: Date | string | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return 0;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");
}

async function findLatestPendingCode(userId: string) {
  const rows = await db.select().from(telegramCodes).where(eq(telegramCodes.userId, userId));
  const pending = rows
    .filter((row) => row.status === "pending")
    .sort((a, b) => toEpoch(a.createdAt) - toEpoch(b.createdAt));
  return pending[pending.length - 1] ?? null;
}

export async function requestTelegramCode(input: { username: string }): Promise<void> {
  const user = await findTelegramLinkedUserByUsername(input.username);
  if (!user) {
    throw new TelegramCodeError("No Telegram-linked account", "NOT_FOUND");
  }

  const rows = await db.select().from(telegramCodes).where(eq(telegramCodes.userId, user.id));
  const recent = rows.filter((row) => toEpoch(row.createdAt) > Date.now() - RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    throw new TelegramCodeError("Rate limit exceeded", "RATE_LIMITED");
  }

  const pendingRecent = rows.find(
    (row) =>
      row.status === "pending" && toEpoch(row.createdAt) > Date.now() - REQUEST_COOLDOWN_MS,
  );
  if (pendingRecent) {
    throw new TelegramCodeError("Resend cooldown", "RESEND_COOLDOWN");
  }

  const code = generateCode();
  const codeHash = sha256Hex(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await db
    .update(telegramCodes)
    .set({ status: "expired" })
    .where(and(eq(telegramCodes.userId, user.id), eq(telegramCodes.status, "pending")));

  const [row] = await db
    .insert(telegramCodes)
    .values({ userId: user.id, codeHash, attempts: 0, status: "pending", expiresAt })
    .returning();

  try {
    await sendMessage({
      chatId: Number(user.telegramId),
      text: botMessages.codeMessage.replace("{code}", code),
    });
  } catch (error) {
    await db
      .update(telegramCodes)
      .set({ status: "expired" })
      .where(eq(telegramCodes.id, row.id));
    if (error instanceof Error && /can't initiate conversation|forbidden/i.test(error.message)) {
      throw new TelegramCodeError("User has not started the bot", "BOT_NOT_STARTED");
    }
    throw new TelegramCodeError("Failed to send the code", "SEND_FAILED");
  }

  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "auth.code_requested",
    entity: "users",
    entityId: user.id,
  });
}

export async function verifyTelegramCode(input: {
  username: string;
  code: string;
}): Promise<{ user: OnboardedUser }> {
  const user = await findTelegramLinkedUserByUsername(input.username);
  if (!user) {
    throw new TelegramCodeError("No active code", "INVALID_CODE");
  }

  const codeRow = await findLatestPendingCode(user.id);
  if (!codeRow) {
    throw new TelegramCodeError("No active code", "INVALID_CODE");
  }

  if (toEpoch(codeRow.expiresAt) < Date.now()) {
    await db
      .update(telegramCodes)
      .set({ status: "expired" })
      .where(eq(telegramCodes.id, codeRow.id));
    throw new TelegramCodeError("Code expired", "CODE_EXPIRED");
  }

  const providedHash = sha256Hex(input.code.trim());
  const valid =
    codeRow.codeHash.length === providedHash.length &&
    timingSafeEqual(Buffer.from(providedHash, "hex"), Buffer.from(codeRow.codeHash, "hex"));

  if (!valid) {
    const attempts = (codeRow.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db
        .update(telegramCodes)
        .set({ attempts, status: "expired" })
        .where(eq(telegramCodes.id, codeRow.id));
      throw new TelegramCodeError("Too many attempts", "TOO_MANY_ATTEMPTS");
    }
    await db
      .update(telegramCodes)
      .set({ attempts })
      .where(eq(telegramCodes.id, codeRow.id));
    throw new TelegramCodeError("Invalid code", "INVALID_CODE");
  }

  await db
    .update(telegramCodes)
    .set({ status: "used", consumedAt: new Date() })
    .where(eq(telegramCodes.id, codeRow.id));

  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "auth.code_verified",
    entity: "users",
    entityId: user.id,
  });

  return { user };
}
