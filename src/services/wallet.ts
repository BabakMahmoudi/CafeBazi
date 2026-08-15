import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { balances, transactions } from "@/db/schema";
import { takFromNumeric } from "@/lib/money";
import { getStellarAccountByUserId } from "@/services/users";

export async function getCachedBalance(userId: string): Promise<bigint> {
  const rows = await db.select().from(balances).where(eq(balances.userId, userId)).limit(1);
  return rows[0] ? takFromNumeric(rows[0].amount) : 0n;
}

export async function getWallet(userId: string) {
  const [balance, history, stellarAccount] = await Promise.all([
    getCachedBalance(userId),
    db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.createdAt))
      .limit(50),
    getStellarAccountByUserId(userId),
  ]);

  return {
    balance,
    stellarAccountId: stellarAccount?.publicKey ?? null,
    transactions: history.map((tx) => ({
      id: tx.id,
      txHash: tx.txHash,
      type: tx.type,
      status: tx.status,
      amount: takFromNumeric(tx.amount),
      memo: tx.memo,
      shopId: tx.shopId,
      fromAccount: tx.fromAccount,
      toAccount: tx.toAccount,
      createdAt: tx.createdAt,
      confirmedAt: tx.confirmedAt,
    })),
  };
}
