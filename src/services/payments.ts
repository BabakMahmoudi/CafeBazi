import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  balances,
  coffeeShops,
  contacts,
  transactions,
  users,
  type TransactionStatus,
  type TransactionType,
} from "@/db/schema";
import { takFromNumeric, takToNumeric } from "@/lib/money";
import { buildSignedPayment, getAccountBalance, getTransactionStatus, submitEnvelope } from "@/services/stellar";
import { getStellarAccountSecret } from "@/services/users";

export const DAILY_SEND_CAP = 50n;
export const DAILY_SEND_COUNT_LIMIT = 20;
export const RECONCILE_TTL_MS = 60_000;
export const CHAT_DEDUP_MEMO_PREFIX = "pay:";

export class PaymentError extends Error {
  constructor(
    message: string,
    public code: "INSUFFICIENT_FUNDS" | "RATE_LIMIT" | "RECIPIENT_NOT_FOUND" | "SHOP_NOT_FOUND" | "ACCOUNT_NOT_READY" | "DUPLICATE" | "INTERNAL",
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

const locks = new Map<string, Promise<void>>();

export async function withAccountLock<T>(accountKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(accountKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(accountKey, gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(accountKey) === gate) {
      locks.delete(accountKey);
    }
  }
}

export type PaymentSource = "miniapp" | "qr" | "chat" | "bot";

type NewTransactionRow = typeof transactions.$inferInsert;

async function getOrCreateUserBalance(userId: string): Promise<bigint> {
  const rows = await db.select().from(balances).where(eq(balances.userId, userId)).limit(1);
  if (rows[0]) {
    return takFromNumeric(rows[0].amount);
  }
  await db.insert(balances).values({ userId, amount: "0" });
  return 0n;
}

async function applyBalanceDelta(userId: string | null, shopId: string | null, delta: bigint) {
  if (userId) {
    const rows = await db.select().from(balances).where(eq(balances.userId, userId)).limit(1);
    const current = rows[0] ? takFromNumeric(rows[0].amount) : 0n;
    const next = current + delta;
    if (rows[0]) {
      await db
        .update(balances)
        .set({ amount: takToNumeric(next), updatedAt: new Date() })
        .where(eq(balances.userId, userId));
    } else {
      await db.insert(balances).values({ userId, amount: takToNumeric(next) });
    }
  }
  if (shopId) {
    const rows = await db.select().from(balances).where(eq(balances.shopId, shopId)).limit(1);
    const current = rows[0] ? takFromNumeric(rows[0].amount) : 0n;
    const next = current + delta;
    if (rows[0]) {
      await db
        .update(balances)
        .set({ amount: takToNumeric(next), updatedAt: new Date() })
        .where(eq(balances.shopId, shopId));
    } else {
      await db.insert(balances).values({ shopId, amount: takToNumeric(next) });
    }
  }
}

async function checkRateLimits(userId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(transactions.type, ["p2p", "gift", "purchase"]),
        gt(transactions.createdAt, startOfDay),
      ),
    );

  const spent = rows.reduce((sum, tx) => sum + takFromNumeric(tx.amount), 0n);
  if (spent + 1n > DAILY_SEND_CAP) {
    throw new PaymentError("Daily send cap exceeded", "RATE_LIMIT");
  }
  if (rows.length >= DAILY_SEND_COUNT_LIMIT) {
    throw new PaymentError("Daily send count limit exceeded", "RATE_LIMIT");
  }
}

async function upsertContact(userId: string, contactUserId: string) {
  const existing = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.contactUserId, contactUserId)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(contacts)
      .set({ lastUsedAt: new Date(), source: "transfer" })
      .where(eq(contacts.id, existing[0].id));
  } else {
    await db.insert(contacts).values({ userId, contactUserId, source: "transfer" });
  }
}

async function writeAudit(entry: {
  actorUserId: string;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    metadata: entry.metadata ?? {},
  });
}

function normalizeMemo(memo: string | undefined): string | undefined {
  const value = memo?.trim();
  if (!value) return undefined;
  if (Buffer.byteLength(value, "utf8") > 28) {
    throw new PaymentError("Memo is too long (max 28 bytes)", "INTERNAL");
  }
  return value;
}

export type ExecutePaymentInput = {
  userId: string;
  amount: bigint;
  type: TransactionType;
  source: PaymentSource;
  recipientUserId?: string;
  shopId?: string;
  memo?: string;
  table?: string;
  dedupKey?: string;
};

export type PaymentResult = {
  id: string;
  txHash: string;
  status: TransactionStatus;
  amount: bigint;
  type: TransactionType;
  memo: string | null;
  recipientUserId?: string;
  shopId?: string | null;
  duplicate?: boolean;
};

export async function executePayment(input: ExecutePaymentInput): Promise<PaymentResult> {
  const sender = await getStellarAccountSecret(input.userId);
  return withAccountLock(sender.publicKey, () => executePaymentUnlocked(input, sender));
}

async function executePaymentUnlocked(
  input: ExecutePaymentInput,
  sender: { publicKey: string; secretKey: string },
): Promise<PaymentResult> {
  if (input.amount <= 0n) {
    throw new PaymentError("Amount must be positive", "INTERNAL");
  }

  const isP2P = input.type === "p2p" || input.type === "gift";
  const isPurchase = input.type === "purchase";

  let recipientUserId: string | undefined;
  let destinationPublicKey: string;
  let shop: (typeof coffeeShops.$inferSelect) | null = null;
  let shopId: string | null | undefined = input.shopId;

  if (isPurchase) {
    const shops = await db
      .select()
      .from(coffeeShops)
      .where(and(eq(coffeeShops.id, input.shopId ?? ""), eq(coffeeShops.isActive, true)))
      .limit(1);
    shop = shops[0] ?? null;
    if (!shop) {
      throw new PaymentError("Shop not found or inactive", "SHOP_NOT_FOUND");
    }
    const shopOwner = await getStellarAccountSecret(shop.merchantId);
    destinationPublicKey = shopOwner.publicKey;
    shopId = shop.id;
  } else if (input.recipientUserId) {
    const recipients = await db
      .select()
      .from(users)
      .where(eq(users.id, input.recipientUserId))
      .limit(1);
    if (!recipients[0]) {
      throw new PaymentError("Recipient not found", "RECIPIENT_NOT_FOUND");
    }
    if (recipients[0].id === input.userId) {
      throw new PaymentError("Cannot send to yourself", "RECIPIENT_NOT_FOUND");
    }
    const recipientAccount = await getStellarAccountSecret(recipients[0].id);
    destinationPublicKey = recipientAccount.publicKey;
    recipientUserId = recipients[0].id;
  } else {
    throw new PaymentError("No payment destination", "INTERNAL");
  }

  const memo = normalizeMemo(input.memo);
  const dedupMemo = input.dedupKey ? `${CHAT_DEDUP_MEMO_PREFIX}${input.dedupKey}` : undefined;
  const storedMemo = dedupMemo ?? memo ?? null;

  if (input.dedupKey) {
    const existing = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, input.userId), eq(transactions.memo, dedupMemo!)))
      .limit(1);
    if (existing[0]) {
      return {
        id: existing[0].id,
        txHash: existing[0].txHash,
        status: existing[0].status,
        amount: takFromNumeric(existing[0].amount),
        type: existing[0].type,
        memo: existing[0].memo,
        recipientUserId,
        shopId: existing[0].shopId,
        duplicate: true,
      };
    }
  }

  const cachedBalance = await getOrCreateUserBalance(input.userId);
  if (input.amount > cachedBalance) {
    throw new PaymentError("Insufficient funds", "INSUFFICIENT_FUNDS");
  }

  const onChainBalance = await getAccountBalance(sender.publicKey);
  if (input.amount > onChainBalance) {
    throw new PaymentError("Insufficient funds", "INSUFFICIENT_FUNDS");
  }

  await checkRateLimits(input.userId);

  const amountStr = takToNumeric(input.amount);
  const signed = await buildSignedPayment({
    sourceSecretKey: sender.secretKey,
    destination: destinationPublicKey,
    amount: amountStr,
    memo: storedMemo ?? undefined,
  });

  const txRow: NewTransactionRow = {
    txHash: signed.txHash,
    type: input.type,
    status: "pending",
    amount: amountStr,
    fromAccount: sender.publicKey,
    toAccount: destinationPublicKey,
    memo: storedMemo,
    userId: input.userId,
    shopId,
  };

  let inserted: typeof transactions.$inferSelect;
  try {
    const rows = await db.insert(transactions).values(txRow).returning();
    inserted = rows[0];
  } catch (error) {
    const duplicate = await db
      .select()
      .from(transactions)
      .where(eq(transactions.txHash, signed.txHash))
      .limit(1);
    if (duplicate[0]) {
      return {
        id: duplicate[0].id,
        txHash: duplicate[0].txHash,
        status: duplicate[0].status,
        amount: takFromNumeric(duplicate[0].amount),
        type: duplicate[0].type,
        memo: duplicate[0].memo,
        recipientUserId,
        shopId: duplicate[0].shopId,
        duplicate: true,
      };
    }
    throw error;
  }

  let status: TransactionStatus;
  try {
    await db
      .update(transactions)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(eq(transactions.id, inserted.id));
    await submitEnvelope(signed.envelopeXdr);
    await db
      .update(transactions)
      .set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() })
      .where(eq(transactions.id, inserted.id));
    status = "confirmed";
  } catch {
    await db
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(transactions.id, inserted.id));
    status = "failed";
  }

  if (status === "confirmed") {
    await applyBalanceDelta(input.userId, null, -input.amount);
    if (isPurchase && shopId) {
      await applyBalanceDelta(null, shopId, input.amount);
    }
    if (recipientUserId) {
      await applyBalanceDelta(recipientUserId, null, input.amount);
    }
    if (recipientUserId && input.userId !== recipientUserId) {
      await upsertContact(input.userId, recipientUserId);
    }
  }

  await writeAudit({
    actorUserId: input.userId,
    action: isPurchase ? "payment.create" : "payment.send",
    entity: "transactions",
    entityId: inserted.id,
    metadata: {
      action: isPurchase ? "purchase" : isP2P ? "p2p" : input.type,
      cups: isPurchase ? Number(input.amount) : undefined,
      amount: amountStr,
      shop: shopId ?? undefined,
      table: input.table ?? undefined,
      source: input.source,
      recipient: recipientUserId ?? undefined,
      status,
    },
  });

  return {
    id: inserted.id,
    txHash: inserted.txHash,
    status,
    amount: input.amount,
    type: inserted.type as TransactionType,
    memo: inserted.memo,
    recipientUserId,
    shopId: inserted.shopId,
    duplicate: false,
  };
}

export async function reconcileTransaction(tx: {
  id: string;
  txHash: string;
  status: TransactionStatus;
  updatedAt: Date;
}): Promise<TransactionStatus> {
  if (tx.status !== "submitted") {
    return tx.status;
  }
  if (Date.now() - tx.updatedAt.getTime() < RECONCILE_TTL_MS) {
    return tx.status;
  }
  const horizonStatus = await getTransactionStatus(tx.txHash);
  if (horizonStatus === "confirmed") {
    await db
      .update(transactions)
      .set({ status: "confirmed", confirmedAt: new Date(), updatedAt: new Date() })
      .where(eq(transactions.id, tx.id));
    return "confirmed";
  }
  if (horizonStatus === "failed") {
    await db
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(transactions.id, tx.id));
    return "failed";
  }
  return tx.status;
}

export async function getPaymentStatus(userId: string, txId: string) {
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)))
    .limit(1);

  const tx = rows[0];
  if (!tx) {
    return null;
  }

  const status = await reconcileTransaction(tx);
  return {
    id: tx.id,
    txHash: tx.txHash,
    type: tx.type,
    status,
    amount: takFromNumeric(tx.amount),
    memo: tx.memo,
    shopId: tx.shopId,
    createdAt: tx.createdAt,
    confirmedAt: tx.confirmedAt,
  };
}
