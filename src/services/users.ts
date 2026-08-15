import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stellarAccounts, users, type StellarAccountStatus } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { createFundedAccount, generateKeypair } from "@/services/stellar";

export type TelegramUserInput = {
  id: number;
  username?: string;
  firstName: string;
  lastName?: string;
  phone?: string;
};

export type OnboardedUser = typeof users.$inferSelect;

export async function upsertUserFromTelegram(input: TelegramUserInput): Promise<OnboardedUser> {
  const telegramId = String(input.id);
  const firstName = input.firstName || input.username || "کاربر";

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, telegramId))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(users)
      .set({
        telegramUsername: input.username ?? existing[0].telegramUsername,
        firstName,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing[0].id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(users)
    .values({
      telegramId,
      telegramUsername: input.username,
      firstName,
      phone: input.phone,
      role: "member",
    })
    .returning();
  return created;
}

export async function getUserById(userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByTelegramId(telegramId: string) {
  const rows = await db.select().from(users).where(eq(users.telegramId, telegramId)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByUsername(username: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.telegramUsername, username))
    .limit(1);
  return rows[0] ?? null;
}

export type AccountCreationResult = {
  status: StellarAccountStatus;
  publicKey: string;
};

export async function ensureStellarAccount(userId: string): Promise<AccountCreationResult> {
  const existing = await db
    .select()
    .from(stellarAccounts)
    .where(eq(stellarAccounts.userId, userId))
    .limit(1);

  if (existing[0]) {
    return { status: existing[0].status, publicKey: existing[0].publicKey };
  }

  const { publicKey, secretKey } = await generateKeypair();

  let status: StellarAccountStatus = "active";
  try {
    await createFundedAccount(publicKey);
  } catch {
    status = "pending_funding";
  }

  await db.insert(stellarAccounts).values({
    userId,
    publicKey,
    encryptedSecret: encryptSecret(secretKey),
    status,
  });

  return { status, publicKey };
}

export async function retryAccountFunding(userId: string): Promise<AccountCreationResult> {
  const existing = await db
    .select()
    .from(stellarAccounts)
    .where(eq(stellarAccounts.userId, userId))
    .limit(1);

  if (!existing[0]) {
    return ensureStellarAccount(userId);
  }
  if (existing[0].status === "active") {
    return { status: existing[0].status, publicKey: existing[0].publicKey };
  }

  let updatedStatus: StellarAccountStatus = "active";
  try {
    await createFundedAccount(existing[0].publicKey);
  } catch {
    updatedStatus = "pending_funding";
  }

  await db
    .update(stellarAccounts)
    .set({ status: updatedStatus, updatedAt: new Date() })
    .where(eq(stellarAccounts.id, existing[0].id));

  return { status: updatedStatus, publicKey: existing[0].publicKey };
}

export async function getStellarAccountSecret(userId: string): Promise<{
  publicKey: string;
  secretKey: string;
}> {
  const rows = await db
    .select()
    .from(stellarAccounts)
    .where(eq(stellarAccounts.userId, userId))
    .limit(1);

  const account = rows[0];
  if (!account || account.status !== "active") {
    throw new Error("No active Stellar account for user");
  }

  return {
    publicKey: account.publicKey,
    secretKey: decryptSecret(account.encryptedSecret),
  };
}

export async function getStellarAccountByUserId(userId: string) {
  const rows = await db
    .select()
    .from(stellarAccounts)
    .where(eq(stellarAccounts.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}
