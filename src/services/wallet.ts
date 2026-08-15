import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { balances, transactions } from "@/db/schema";
import { takFromNumeric, takToNumeric } from "@/lib/money";
import { getStellarAccountByUserId } from "@/services/users";
import { getAccountBalance } from "@/services/stellar";

export async function getCachedBalance(userId: string): Promise<bigint> {
  const rows = await db.select().from(balances).where(eq(balances.userId, userId)).limit(1);
  return rows[0] ? takFromNumeric(rows[0].amount) : 0n;
}

export async function syncBalanceFromChain(userId: string): Promise<{ balance: bigint; synced: boolean }> {
  const account = await getStellarAccountByUserId(userId);
  if (!account || account.status !== "active") {
    return { balance: await getCachedBalance(userId), synced: false };
  }

  const balance = await getAccountBalance(account.publicKey);
  const amount = takToNumeric(balance);
  const rows = await db.select().from(balances).where(eq(balances.userId, userId)).limit(1);

  if (rows[0]) {
    await db
      .update(balances)
      .set({ amount, updatedAt: new Date() })
      .where(eq(balances.id, rows[0].id));
  } else {
    await db.insert(balances).values({ userId, amount });
  }

  return { balance, synced: true };
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
