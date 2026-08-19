import "server-only";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@/db";
import {
  authChallenges,
  balances,
  stellarAccounts,
  users,
  walletLinks,
  type AuthChallengePurpose,
} from "@/db/schema";
import { env } from "@/lib/env";
import { getNetworkPassphrase, isValidStellarAddress } from "@/services/stellar";

const CHALLENGE_TTL_SECONDS = 300;
const MAX_PENDING_CHALLENGES = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

type StellarSdk = typeof import("@stellar/stellar-sdk");

let sdkPromise: Promise<StellarSdk> | null = null;

function sdk(): Promise<StellarSdk> {
  if (!sdkPromise) {
    sdkPromise = import("@stellar/stellar-sdk");
  }
  return sdkPromise;
}

function appHostname(): string {
  return new URL(env.NEXT_PUBLIC_APP_URL).hostname.toLowerCase();
}

async function sep10Keypair(): Promise<{
  publicKey: string;
  keypair: InstanceType<StellarSdk["Keypair"]>;
}> {
  const s = await sdk();
  const keypair = s.Keypair.fromSecret(env.SEP10_SIGNING_KEY);
  return { publicKey: keypair.publicKey(), keypair };
}

export class AuthChallengeError extends Error {
  constructor(
    message: string,
    public code:
      | "INVALID_PUBLIC_KEY"
      | "SERVER_KEY"
      | "CUSTODIAL_KEY"
      | "RATE_LIMIT"
      | "INVALID_SIGNATURE"
      | "CHALLENGE_NOT_FOUND"
      | "CHALLENGE_USED"
      | "CHALLENGE_EXPIRED"
      | "PURPOSE_MISMATCH",
  ) {
    super(message);
    this.name = "AuthChallengeError";
  }
}

export class WalletLinkError extends Error {
  constructor(
    message: string,
    public code: "INVALID_ADDRESS" | "CUSTODIAL_KEY" | "ALREADY_LINKED" | "LAST_WALLET" | "NOT_FOUND",
  ) {
    super(message);
    this.name = "WalletLinkError";
  }
}

export type IssuedChallenge = {
  challengeXdr: string;
  networkPassphrase: string;
  expiresAt: Date;
};

export async function issueChallenge(input: {
  publicKey: string;
  purpose: AuthChallengePurpose;
}): Promise<IssuedChallenge> {
  const publicKey = input.publicKey.trim();

  if (!(await isValidStellarAddress(publicKey))) {
    throw new AuthChallengeError("Invalid Stellar address", "INVALID_PUBLIC_KEY");
  }

  const { publicKey: sep10PublicKey, keypair } = await sep10Keypair();
  if (publicKey === sep10PublicKey) {
    throw new AuthChallengeError("Cannot authenticate as the server key", "SERVER_KEY");
  }

  const custodial = await db
    .select()
    .from(stellarAccounts)
    .where(eq(stellarAccounts.publicKey, publicKey))
    .limit(1);
  if (custodial[0]) {
    throw new AuthChallengeError("Custodial address cannot be used", "CUSTODIAL_KEY");
  }

  const windowStart = new Date(Date.now() - RATE_WINDOW_MS);
  const pending = await db
    .select()
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.publicKey, publicKey),
        eq(authChallenges.status, "pending"),
        gt(authChallenges.createdAt, windowStart),
      ),
    );
  if (pending.length >= MAX_PENDING_CHALLENGES) {
    throw new AuthChallengeError("Too many pending challenges", "RATE_LIMIT");
  }

  const nonce = randomBytes(8).readBigUInt64BE().toString();
  const networkPassphrase = await getNetworkPassphrase();
  const homeDomain = appHostname();

  const s = await sdk();
  const challengeXdr = s.WebAuth.buildChallengeTx(
    keypair,
    publicKey,
    homeDomain,
    CHALLENGE_TTL_SECONDS,
    networkPassphrase,
    homeDomain,
    nonce,
  );

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000);
  await db.insert(authChallenges).values({
    publicKey,
    nonce,
    purpose: input.purpose,
    status: "pending",
    expiresAt,
  });

  return { challengeXdr, networkPassphrase, expiresAt };
}

export async function verifyChallenge(input: {
  signedChallengeXdr: string;
  purpose: AuthChallengePurpose;
}): Promise<string> {
  const s = await sdk();
  const { publicKey: sep10PublicKey } = await sep10Keypair();
  const networkPassphrase = await getNetworkPassphrase();
  const homeDomain = appHostname();

  let clientAccountID: string;
  let memo: string | null;
  try {
    const read = s.WebAuth.readChallengeTx(
      input.signedChallengeXdr,
      sep10PublicKey,
      networkPassphrase,
      homeDomain,
      homeDomain,
    );
    clientAccountID = read.clientAccountID;
    memo = read.memo;
  } catch {
    throw new AuthChallengeError("Challenge is not valid", "INVALID_SIGNATURE");
  }

  try {
    const signers = s.WebAuth.verifyChallengeTxSigners(
      input.signedChallengeXdr,
      sep10PublicKey,
      networkPassphrase,
      [clientAccountID],
      homeDomain,
      homeDomain,
    );
    if (!signers.includes(clientAccountID)) {
      throw new AuthChallengeError(
        "Challenge not signed by the requested account",
        "INVALID_SIGNATURE",
      );
    }
  } catch (error) {
    if (error instanceof AuthChallengeError) {
      throw error;
    }
    throw new AuthChallengeError("Challenge is not signed by the wallet", "INVALID_SIGNATURE");
  }

  if (!memo) {
    throw new AuthChallengeError("Challenge is missing its nonce", "CHALLENGE_NOT_FOUND");
  }

  const rows = await db
    .select()
    .from(authChallenges)
    .where(and(eq(authChallenges.nonce, memo), eq(authChallenges.publicKey, clientAccountID)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AuthChallengeError("Challenge not found", "CHALLENGE_NOT_FOUND");
  }
  if (row.status !== "pending") {
    throw new AuthChallengeError("Challenge already used", "CHALLENGE_USED");
  }
  if (row.purpose !== input.purpose) {
    throw new AuthChallengeError("Challenge purpose mismatch", "PURPOSE_MISMATCH");
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new AuthChallengeError("Challenge expired", "CHALLENGE_EXPIRED");
  }

  const consumed = await db
    .update(authChallenges)
    .set({ status: "used" })
    .where(and(eq(authChallenges.id, row.id), eq(authChallenges.status, "pending")))
    .returning();
  if (consumed.length !== 1) {
    throw new AuthChallengeError("Challenge already used", "CHALLENGE_USED");
  }

  return clientAccountID;
}

export async function resolveStellarLogin(publicKey: string): Promise<{
  user: typeof users.$inferSelect;
  isNewUser: boolean;
}> {
  const link = await findLinkByPublicKey(publicKey);
  if (link) {
    const existing = await db.select().from(users).where(eq(users.id, link.userId)).limit(1);
    if (existing[0]) {
      return { user: existing[0], isNewUser: false };
    }
  }

  const firstName = `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
  const telegramId = `web-${crypto.randomUUID()}`;

  try {
    const [created] = await db
      .insert(users)
      .values({ telegramId, firstName, role: "member" })
      .returning();
    await db
      .insert(walletLinks)
      .values({ userId: created.id, publicKey, source: "stellar", verifiedAt: new Date() });
    await db.insert(balances).values({ userId: created.id, amount: "0" });
    return { user: created, isNewUser: true };
  } catch (error) {
    const raced = await findLinkByPublicKey(publicKey);
    if (raced) {
      const racedUser = await db.select().from(users).where(eq(users.id, raced.userId)).limit(1);
      if (racedUser[0]) {
        return { user: racedUser[0], isNewUser: false };
      }
    }
    throw error;
  }
}

async function findLinkByPublicKey(publicKey: string) {
  const rows = await db
    .select()
    .from(walletLinks)
    .where(eq(walletLinks.publicKey, publicKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function listWalletLinks(userId: string) {
  const rows = await db
    .select()
    .from(walletLinks)
    .where(eq(walletLinks.userId, userId))
    .orderBy(desc(walletLinks.createdAt));
  return rows.map((row) => ({
    id: row.id,
    publicKey: row.publicKey,
    source: row.source,
    label: row.label,
    verifiedAt: row.verifiedAt,
  }));
}

export async function linkWallet(userId: string, publicKey: string): Promise<string> {
  const pk = publicKey.trim();

  if (!(await isValidStellarAddress(pk))) {
    throw new WalletLinkError("Invalid Stellar address", "INVALID_ADDRESS");
  }

  const { publicKey: sep10PublicKey } = await sep10Keypair();
  if (pk === sep10PublicKey) {
    throw new WalletLinkError("Server key cannot be linked", "CUSTODIAL_KEY");
  }

  const custodial = await db
    .select()
    .from(stellarAccounts)
    .where(eq(stellarAccounts.publicKey, pk))
    .limit(1);
  if (custodial[0]) {
    throw new WalletLinkError("Custodial address cannot be linked", "CUSTODIAL_KEY");
  }

  const existing = await findLinkByPublicKey(pk);
  if (existing) {
    throw new WalletLinkError("Wallet is already linked to an account", "ALREADY_LINKED");
  }

  await db
    .insert(walletLinks)
    .values({ userId, publicKey: pk, source: "stellar", verifiedAt: new Date() });
  return pk;
}

export async function unlinkWallet(userId: string, publicKey: string): Promise<{ removed: boolean }> {
  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const links = await db
    .select()
    .from(walletLinks)
    .where(eq(walletLinks.userId, userId))
    .orderBy(asc(walletLinks.createdAt));

  const target = links.find((link) => link.publicKey === publicKey);
  if (!target) {
    throw new WalletLinkError("Wallet link not found", "NOT_FOUND");
  }
  if (links.length === 1 && user[0]?.telegramId.startsWith("web-")) {
    throw new WalletLinkError("Cannot remove your only sign-in method", "LAST_WALLET");
  }

  await db
    .delete(walletLinks)
    .where(and(eq(walletLinks.userId, userId), eq(walletLinks.publicKey, publicKey)));
  return { removed: true };
}
