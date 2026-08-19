import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  authCredentials,
  balances,
  users,
  type StellarAccountStatus,
} from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/password";
import { ensureStellarAccount, type OnboardedUser } from "@/services/users";

const USERNAME_PATTERN = /^[a-z0-9_]{5,32}$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export class AuthPasswordError extends Error {
  constructor(
    message: string,
    public code:
      | "INVALID_USERNAME"
      | "WEAK_PASSWORD"
      | "USERNAME_TAKEN"
      | "INVALID_CREDENTIALS"
      | "ACCOUNT_LOCKED"
      | "INTERNAL",
  ) {
    super(message);
    this.name = "AuthPasswordError";
  }
}

export function normalizeUsername(raw: string): string {
  const username = raw.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthPasswordError("Invalid username", "INVALID_USERNAME");
  }
  return username;
}

export async function signupWithPassword(input: {
  username: string;
  password: string;
}): Promise<{ user: OnboardedUser; accountStatus: StellarAccountStatus }> {
  const username = normalizeUsername(input.username);
  if (input.password.length < PASSWORD_MIN_LENGTH || input.password.length > PASSWORD_MAX_LENGTH) {
    throw new AuthPasswordError("Password does not meet the policy", "WEAK_PASSWORD");
  }

  const passwordHash = await hashPassword(input.password);
  const telegramId = `password-${crypto.randomUUID()}`;

  let user: OnboardedUser;
  try {
    const [created] = await db
      .insert(users)
      .values({
        telegramId,
        telegramUsername: username,
        firstName: username,
        role: "member",
      })
      .returning();
    user = created;

    await db.insert(authCredentials).values({
      userId: user.id,
      username,
      passwordHash,
      failedAttempts: 0,
    });
    await db.insert(balances).values({ userId: user.id, amount: "0" });
  } catch (error) {
    if (error instanceof Error && /duplicate key/i.test(error.message)) {
      throw new AuthPasswordError("Username is taken", "USERNAME_TAKEN");
    }
    throw error;
  }

  const account = await ensureStellarAccount(user.id);

  await db.insert(auditLog).values({
    actorUserId: user.id,
    action: "auth.signup",
    entity: "users",
    entityId: user.id,
  });

  return { user, accountStatus: account.status };
}

export async function signinWithPassword(input: {
  username: string;
  password: string;
}): Promise<{ user: OnboardedUser }> {
  const username = normalizeUsername(input.username);

  const credentialRows = await db
    .select()
    .from(authCredentials)
    .where(eq(authCredentials.username, username))
    .limit(1);
  const credential = credentialRows[0];
  if (!credential) {
    throw new AuthPasswordError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) {
    throw new AuthPasswordError("Account is locked", "ACCOUNT_LOCKED");
  }

  const valid = await verifyPassword(input.password, credential.passwordHash);
  if (!valid) {
    const failedAttempts = credential.failedAttempts + 1;
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      await db
        .update(authCredentials)
        .set({
          failedAttempts: 0,
          lockedUntil: new Date(Date.now() + LOCKOUT_MS),
          updatedAt: new Date(),
        })
        .where(eq(authCredentials.id, credential.id));
    } else {
      await db
        .update(authCredentials)
        .set({ failedAttempts, updatedAt: new Date() })
        .where(eq(authCredentials.id, credential.id));
    }
    throw new AuthPasswordError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  await db
    .update(authCredentials)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(authCredentials.id, credential.id));

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, credential.userId))
    .limit(1);
  const user = userRows[0];
  if (!user) {
    throw new AuthPasswordError("User not found", "INTERNAL");
  }

  return { user };
}
