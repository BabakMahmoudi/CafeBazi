import "server-only";
import { TRPCError } from "@trpc/server";
import { desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
  balances,
  stellarAccounts,
  users,
  type StellarAccountStatus,
  type UserRole,
} from "@/db/schema";
import { takFromNumeric } from "@/lib/money";
import { ensureStellarAccount } from "@/services/users";
import { syncBalanceFromChain } from "@/services/wallet";

export type AdminUserView = {
  id: string;
  telegramId: string;
  telegramUsername: string | null;
  firstName: string;
  phone: string | null;
  role: UserRole;
  publicKey: string | null;
  accountStatus: StellarAccountStatus | null;
  balance: bigint;
  createdAt: Date;
};

type UserRow = typeof users.$inferSelect;

function toView(
  user: UserRow,
  account: { publicKey: string; status: StellarAccountStatus } | null,
  balance: bigint,
): AdminUserView {
  return {
    id: user.id,
    telegramId: user.telegramId,
    telegramUsername: user.telegramUsername,
    firstName: user.firstName,
    phone: user.phone,
    role: user.role,
    publicKey: account?.publicKey ?? null,
    accountStatus: account?.status ?? null,
    balance,
    createdAt: user.createdAt,
  };
}

export async function listUsersForAdmin(input: {
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: AdminUserView[]; hasMore: boolean }> {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const query = input.query?.trim();

  const conditions = query
    ? or(
        ilike(users.firstName, `%${query}%`),
        ilike(users.telegramUsername, `%${query}%`),
      )
    : undefined;

  const rows = await db
    .select()
    .from(users)
    .where(conditions)
    .orderBy(desc(users.createdAt))
    .limit(offset + limit + 1);

  const page = rows.slice(offset, offset + limit);
  const hasMore = rows.length > offset + limit;

  if (page.length === 0) {
    return { items: [], hasMore };
  }

  const ids = page.map((u) => u.id);
  const [balanceRows, accountRows] = await Promise.all([
    db.select().from(balances).where(inArray(balances.userId, ids)),
    db.select().from(stellarAccounts).where(inArray(stellarAccounts.userId, ids)),
  ]);

  const balanceById = new Map(balanceRows.map((b) => [b.userId, takFromNumeric(b.amount)]));
  const accountById = new Map(accountRows.map((a) => [a.userId, a]));

  return {
    items: page.map((u) =>
      toView(u, accountById.get(u.id) ?? null, balanceById.get(u.id) ?? 0n),
    ),
    hasMore,
  };
}

export async function createUserForAdmin(input: {
  firstName: string;
  telegramId?: string;
  telegramUsername?: string;
  phone?: string;
  role: UserRole;
}): Promise<AdminUserView> {
  const telegramId = input.telegramId?.trim() || `manual-${crypto.randomUUID()}`;

  let created: UserRow;
  try {
    const rows = await db
      .insert(users)
      .values({
        telegramId,
        telegramUsername: input.telegramUsername ?? null,
        firstName: input.firstName,
        phone: input.phone ?? null,
        role: input.role,
      })
      .returning();
    created = rows[0];
  } catch (error) {
    if (error instanceof Error && /duplicate key/i.test(error.message)) {
      throw new TRPCError({ code: "CONFLICT", message: "duplicate key" });
    }
    throw error;
  }

  const account = await ensureStellarAccount(created.id);

  const existing = await db
    .select()
    .from(balances)
    .where(eq(balances.userId, created.id))
    .limit(1);
  if (!existing[0]) {
    await db.insert(balances).values({ userId: created.id, amount: "0" });
  }

  return toView(created, account, 0n);
}

async function loadView(userId: string, user: UserRow): Promise<AdminUserView> {
  const [balanceRows, accountRows] = await Promise.all([
    db.select().from(balances).where(eq(balances.userId, userId)).limit(1),
    db.select().from(stellarAccounts).where(eq(stellarAccounts.userId, userId)).limit(1),
  ]);
  return toView(
    user,
    accountRows[0] ?? null,
    balanceRows[0] ? takFromNumeric(balanceRows[0].amount) : 0n,
  );
}

async function countAdmins(): Promise<number> {
  const rows = await db.select().from(users).where(eq(users.role, "admin"));
  return rows.length;
}

export async function updateUserForAdmin(input: {
  userId: string;
  actorUserId: string;
  firstName?: string;
  telegramUsername?: string;
  phone?: string | null;
  role?: UserRole;
}): Promise<AdminUserView> {
  const rows = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  const target = rows[0];
  if (!target) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  if (input.role !== undefined && input.role !== target.role && input.role !== "admin") {
    if (target.id === input.actorUserId) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Cannot demote yourself" });
    }
    if (target.role === "admin" && (await countAdmins()) <= 1) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Cannot demote the last admin" });
    }
  }

  const [updated] = await db
    .update(users)
    .set({
      ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      ...(input.telegramUsername !== undefined ? { telegramUsername: input.telegramUsername } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, input.userId))
    .returning();

  return loadView(input.userId, updated);
}

export async function syncUserBalanceForAdmin(userId: string) {
  return syncBalanceFromChain(userId);
}
