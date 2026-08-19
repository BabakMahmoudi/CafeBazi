import "server-only";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, balances, gameScores, gameSessions, transactions } from "@/db/schema";
import { env } from "@/lib/env";
import { takFromNumeric, takToNumeric } from "@/lib/money";
import { buildSignedPayment, getAccountBalance, submitEnvelope } from "@/services/stellar";
import { ensureStellarAccount, getStellarAccountSecret, retryAccountFunding } from "@/services/users";
import { withAccountLock } from "@/services/payments";

export const GAME_NAME = "espresso_roulette";
export const SESSION_TTL_MS = 10 * 60_000;
export const FREE_SPINS_PER_DAY = 1;
export const PAID_SPIN_COST = 1n;
export const PAID_SPINS_PER_DAY = 10;

export type Slot = {
  emoji: string;
  prize: bigint;
  labelKey: "burnt" | "cup" | "double" | "jackpot";
};

export const SLOTS: Slot[] = [
  { emoji: "🥀", prize: 0n, labelKey: "burnt" },
  { emoji: "☕", prize: 1n, labelKey: "cup" },
  { emoji: "🎁", prize: 2n, labelKey: "double" },
  { emoji: "🥀", prize: 0n, labelKey: "burnt" },
  { emoji: "👑", prize: 5n, labelKey: "jackpot" },
  { emoji: "🥀", prize: 0n, labelKey: "burnt" },
  { emoji: "☕", prize: 1n, labelKey: "cup" },
  { emoji: "🎁", prize: 2n, labelKey: "double" },
];

export const FREE_WEIGHTS = [20, 15, 5, 20, 2, 20, 15, 3];
export const PAID_WEIGHTS = [10, 22, 9, 10, 7, 10, 22, 10];

export type GameErrorCode =
  | "SESSION_INVALID"
  | "SESSION_EXPIRED"
  | "SESSION_USED"
  | "RATE_LIMIT"
  | "INSUFFICIENT_FUNDS"
  | "ACCOUNT_NOT_READY"
  | "POOL_UNAVAILABLE"
  | "INTERNAL";

export class GameError extends Error {
  constructor(
    message: string,
    public code: GameErrorCode,
  ) {
    super(message);
    this.name = "GameError";
  }
}

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

export function computeSessionHmac(userId: string, nonce: string): string {
  return createHmac("sha256", env.KEY_ENCRYPTION_KEY)
    .update(`${GAME_NAME}|${userId}|${nonce}`)
    .digest("hex");
}

export type GameSessionData = {
  sessionId: string;
  nonce: string;
  hmac: string;
  expiresAt: Date;
  freeSpinsRemaining: number;
  paidSpinCost: bigint;
  paidSpinsRemaining: number;
};

export async function createGameSession(userId: string): Promise<GameSessionData> {
  const startOfDay = startOfToday();
  const [sessionsToday, paidEntriesToday] = await Promise.all([
    db
      .select()
      .from(gameSessions)
      .where(
        and(
          eq(gameSessions.userId, userId),
          eq(gameSessions.game, GAME_NAME),
          gt(gameSessions.createdAt, startOfDay),
        ),
      ),
    db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.type, "game_entry"),
          gt(transactions.createdAt, startOfDay),
        ),
      ),
  ]);

  const freeSpinsUsed = sessionsToday.length - paidEntriesToday.length;
  const freeSpinsRemaining = Math.max(0, FREE_SPINS_PER_DAY - freeSpinsUsed);
  const paidSpinsRemaining = Math.max(0, PAID_SPINS_PER_DAY - paidEntriesToday.length);

  if (freeSpinsRemaining === 0 && paidSpinsRemaining === 0) {
    throw new GameError("No spins left today", "RATE_LIMIT");
  }

  const nonce = randomBytes(16).toString("hex");
  const hmac = computeSessionHmac(userId, nonce);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const [row] = await db
    .insert(gameSessions)
    .values({
      userId,
      game: GAME_NAME,
      nonce,
      hmac,
      expiresAt,
      status: "active",
      createdAt: new Date(),
    })
    .returning();

  return {
    sessionId: row.id,
    nonce,
    hmac,
    expiresAt: row.expiresAt,
    freeSpinsRemaining,
    paidSpinCost: PAID_SPIN_COST,
    paidSpinsRemaining,
  };
}

export async function verifySessionHmac(input: {
  userId: string;
  sessionId: string;
  nonce: string;
  hmac: string;
}): Promise<typeof gameSessions.$inferSelect> {
  const rows = await db
    .select()
    .from(gameSessions)
    .where(
      and(
        eq(gameSessions.id, input.sessionId),
        eq(gameSessions.userId, input.userId),
        eq(gameSessions.game, GAME_NAME),
      ),
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw new GameError("Game session not found", "SESSION_INVALID");
  }
  if (session.nonce !== input.nonce) {
    throw new GameError("Game session nonce mismatch", "SESSION_INVALID");
  }

  const expected = computeSessionHmac(input.userId, session.nonce);
  const actual = Buffer.from(input.hmac, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
    throw new GameError("Game session HMAC mismatch", "SESSION_INVALID");
  }

  if (session.expiresAt.getTime() < Date.now()) {
    throw new GameError("Game session expired", "SESSION_EXPIRED");
  }

  const updated = await db
    .update(gameSessions)
    .set({ status: "used" })
    .where(and(eq(gameSessions.id, session.id), eq(gameSessions.status, "active")))
    .returning();

  if (updated.length === 0) {
    throw new GameError("Game session already used", "SESSION_USED");
  }

  return session;
}

export type SpinOutcome = {
  position: number;
  emoji: string;
  prize: bigint;
  labelKey: Slot["labelKey"];
};

export function drawOutcome(spinType: "free" | "paid"): SpinOutcome {
  const weights = spinType === "paid" ? PAID_WEIGHTS : FREE_WEIGHTS;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const roll = randomInt(total);
  let cumulative = 0;
  for (let position = 0; position < weights.length; position++) {
    cumulative += weights[position];
    if (roll < cumulative) {
      const slot = SLOTS[position];
      return { position, emoji: slot.emoji, prize: slot.prize, labelKey: slot.labelKey };
    }
  }
  throw new GameError("Weighted draw exhausted", "INTERNAL");
}

async function getOrCreateUserBalance(userId: string): Promise<bigint> {
  const rows = await db.select().from(balances).where(eq(balances.userId, userId)).limit(1);
  if (rows[0]) {
    return takFromNumeric(rows[0].amount);
  }
  await db.insert(balances).values({ userId, amount: "0" });
  return 0n;
}

async function getCachedBalance(userId: string): Promise<bigint> {
  const rows = await db.select().from(balances).where(eq(balances.userId, userId)).limit(1);
  return rows[0] ? takFromNumeric(rows[0].amount) : 0n;
}

async function applyBalanceDelta(userId: string, delta: bigint) {
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

async function activateSender(userId: string): Promise<{ publicKey: string; secretKey: string }> {
  await ensureStellarAccount(userId);
  try {
    return await getStellarAccountSecret(userId);
  } catch {
    await retryAccountFunding(userId);
    try {
      return await getStellarAccountSecret(userId);
    } catch {
      throw new GameError("Stellar account is not ready", "ACCOUNT_NOT_READY");
    }
  }
}

async function submitTransfer(input: {
  sourceSecretKey: string;
  fromAccount: string;
  toAccount: string;
  amount: bigint;
  type: "game_entry" | "game_reward";
  userId: string;
}): Promise<{ id: string; txHash: string; confirmed: boolean; created: boolean }> {
  const amountStr = takToNumeric(input.amount);
  const signed = await buildSignedPayment({
    sourceSecretKey: input.sourceSecretKey,
    destination: input.toAccount,
    amount: amountStr,
  });

  const txRow = {
    txHash: signed.txHash,
    type: input.type,
    status: "pending" as const,
    amount: amountStr,
    fromAccount: input.fromAccount,
    toAccount: input.toAccount,
    userId: input.userId,
    createdAt: new Date(),
  };

  let inserted: typeof transactions.$inferSelect;
  try {
    [inserted] = await db.insert(transactions).values(txRow).returning();
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
        confirmed: duplicate[0].status === "confirmed",
        created: false,
      };
    }
    throw error;
  }

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
    return { id: inserted.id, txHash: inserted.txHash, confirmed: true, created: true };
  } catch {
    await db
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(transactions.id, inserted.id));
    return { id: inserted.id, txHash: inserted.txHash, confirmed: false, created: true };
  }
}

async function attemptEntryRefund(
  userId: string,
  memberPublicKey: string,
): Promise<boolean> {
  if (!memberPublicKey) {
    return false;
  }
  try {
    const refund = await submitTransfer({
      sourceSecretKey: env.GAME_POOL_SECRET_KEY,
      fromAccount: env.GAME_POOL_PUBLIC_KEY,
      toAccount: memberPublicKey,
      amount: PAID_SPIN_COST,
      type: "game_reward",
      userId,
    });
    if (refund.confirmed) {
      if (refund.created) {
        await applyBalanceDelta(userId, PAID_SPIN_COST);
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export type SpinInput = {
  userId: string;
  sessionId: string;
  nonce: string;
  hmac: string;
  spinType: "free" | "paid";
};

export type SpinResult = {
  outcome: SpinOutcome;
  freeSpinsRemaining: number;
  paidSpinsRemaining: number;
  prizeTxHash?: string;
  feeTxHash?: string;
  balance: bigint;
};

export async function spinRoulette(input: SpinInput): Promise<SpinResult> {
  return withAccountLock(`user:${input.userId}`, async () => {
    const session = await verifySessionHmac({
      userId: input.userId,
      sessionId: input.sessionId,
      nonce: input.nonce,
      hmac: input.hmac,
    });

    const startOfDay = startOfToday();
    const paidEntriesToday = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, input.userId),
          eq(transactions.type, "game_entry"),
          gt(transactions.createdAt, startOfDay),
        ),
      );

    let memberPublicKey: string | undefined;
    let feeTxHash: string | undefined;

    if (input.spinType === "paid") {
      if (paidEntriesToday.length >= PAID_SPINS_PER_DAY) {
        throw new GameError("Daily paid spin cap exceeded", "RATE_LIMIT");
      }
      const sender = await activateSender(input.userId);
      memberPublicKey = sender.publicKey;

      const cachedBalance = await getOrCreateUserBalance(input.userId);
      if (PAID_SPIN_COST > cachedBalance) {
        throw new GameError("Insufficient funds", "INSUFFICIENT_FUNDS");
      }
      const onChainBalance = await getAccountBalance(sender.publicKey);
      if (PAID_SPIN_COST > onChainBalance) {
        throw new GameError("Insufficient funds", "INSUFFICIENT_FUNDS");
      }

      const fee = await submitTransfer({
        sourceSecretKey: sender.secretKey,
        fromAccount: sender.publicKey,
        toAccount: env.GAME_POOL_PUBLIC_KEY,
        amount: PAID_SPIN_COST,
        type: "game_entry",
        userId: input.userId,
      });
      feeTxHash = fee.txHash;
      if (!fee.confirmed) {
        throw new GameError("Entry fee transfer failed", "INTERNAL");
      }
      if (fee.created) {
        await applyBalanceDelta(input.userId, -PAID_SPIN_COST);
      }
    } else {
      const sessionsToday = await db
        .select()
        .from(gameSessions)
        .where(
          and(
            eq(gameSessions.userId, input.userId),
            eq(gameSessions.game, GAME_NAME),
            gt(gameSessions.createdAt, startOfDay),
          ),
        );
      const currentIncluded = sessionsToday.some((row) => row.id === session.id);
      const freeSpinsUsed = sessionsToday.length - (currentIncluded ? 1 : 0) - paidEntriesToday.length;
      if (freeSpinsUsed >= FREE_SPINS_PER_DAY) {
        throw new GameError("Daily free spin cap exceeded", "RATE_LIMIT");
      }
    }

    const outcome = drawOutcome(input.spinType);

    let prizeTxHash: string | undefined;
    if (outcome.prize > 0n) {
      if (!memberPublicKey) {
        const member = await activateSender(input.userId);
        memberPublicKey = member.publicKey;
      }

      let prizeFailed = false;
      try {
        const prize = await submitTransfer({
          sourceSecretKey: env.GAME_POOL_SECRET_KEY,
          fromAccount: env.GAME_POOL_PUBLIC_KEY,
          toAccount: memberPublicKey,
          amount: outcome.prize,
          type: "game_reward",
          userId: input.userId,
        });
        prizeTxHash = prize.txHash;
        if (prize.confirmed) {
          if (prize.created) {
            await applyBalanceDelta(input.userId, outcome.prize);
          }
        } else {
          prizeFailed = true;
        }
      } catch {
        prizeFailed = true;
      }

      if (prizeFailed) {
        const refunded =
          input.spinType === "paid" ? await attemptEntryRefund(input.userId, memberPublicKey) : false;
        if (!refunded) {
          await db.insert(auditLog).values({
            actorUserId: input.userId,
            action: "game.refund",
            entity: "transactions",
            metadata: {
              game: GAME_NAME,
              spinType: input.spinType,
              position: outcome.position,
              prize: Number(outcome.prize),
              needsRefund: true,
            },
          });
        }
        throw new GameError("Prize transfer failed", "POOL_UNAVAILABLE");
      }
    }

    const [scoreRow] = await db
      .insert(gameScores)
      .values({ userId: input.userId, gameSessionId: session.id, score: outcome.position })
      .returning();

    await db.insert(auditLog).values({
      actorUserId: input.userId,
      action: "game.spin",
      entity: "game_scores",
      entityId: scoreRow.id,
      metadata: {
        game: GAME_NAME,
        spinType: input.spinType,
        position: outcome.position,
        prize: Number(outcome.prize),
        prizeTx: prizeTxHash,
        feeTx: feeTxHash,
      },
    });

    const [sessionsToday, paidEntriesAfter] = await Promise.all([
      db
        .select()
        .from(gameSessions)
        .where(
          and(
            eq(gameSessions.userId, input.userId),
            eq(gameSessions.game, GAME_NAME),
            gt(gameSessions.createdAt, startOfDay),
          ),
        ),
      db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, input.userId),
            eq(transactions.type, "game_entry"),
            gt(transactions.createdAt, startOfDay),
          ),
        ),
    ]);
    const freeSpinsUsed = sessionsToday.length - paidEntriesAfter.length;
    const freeSpinsRemaining = Math.max(0, FREE_SPINS_PER_DAY - freeSpinsUsed);
    const paidSpinsRemaining = Math.max(0, PAID_SPINS_PER_DAY - paidEntriesAfter.length);

    return {
      outcome,
      freeSpinsRemaining,
      paidSpinsRemaining,
      prizeTxHash,
      feeTxHash,
      balance: await getCachedBalance(input.userId),
    };
  });
}
