import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { createFakeDb } from "../../../tests/helpers/fake-db";
import {
  AuthChallengeError,
  issueChallenge,
  linkWallet,
  listWalletLinks,
  resolveStellarLogin,
  unlinkWallet,
  verifyChallenge,
  WalletLinkError,
} from "@/services/auth-stellar";

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createFakeDb>,
  stellar: {
    getNetworkPassphrase: vi.fn(async () => Networks.TESTNET),
    isValidStellarAddress: vi.fn(async (address: string) => address.startsWith("G")),
  },
}));

vi.mock("@/db", () => ({ get db() { return h.db; } }));
vi.mock("@/services/stellar", () => h.stellar);

const SERVER_SECRET = process.env.SEP10_SIGNING_KEY as string;
const SERVER_PUBLIC = Keypair.fromSecret(SERVER_SECRET).publicKey();

const CLIENT_SECRET = "SCKUYUK3FVUVAG2FHEHJUV6AG6N24EGP4NV4MD7L6MU6OGC3DTU6Q6WI";
const CLIENT = Keypair.fromSecret(CLIENT_SECRET);
const CLIENT_PUBLIC = CLIENT.publicKey();

function signChallenge(challengeXdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(challengeXdr, Networks.TESTNET);
  tx.sign(keypair);
  return tx.toEnvelope().toXDR("base64").toString();
}

function seedDb(overrides: {
  users?: Array<Record<string, unknown>>;
  stellarAccounts?: Array<Record<string, unknown>>;
  walletLinks?: Array<Record<string, unknown>>;
  authChallenges?: Array<Record<string, unknown>>;
  balances?: Array<Record<string, unknown>>;
} = {}) {
  return createFakeDb(
    {
      users: overrides.users ?? [
        { id: "u1", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" },
      ],
      stellar_accounts: overrides.stellarAccounts ?? [],
      wallet_links: overrides.walletLinks ?? [],
      auth_challenges: overrides.authChallenges ?? [],
      balances: overrides.balances ?? [],
    },
    { unique: { wallet_links: ["publicKey"], auth_challenges: ["nonce"] } },
  );
}

describe("auth-stellar service — SEP-10 challenges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
  });

  it("issues a challenge and verifies a valid signature", async () => {
    const issued = await issueChallenge({ publicKey: CLIENT_PUBLIC, purpose: "login" });

    expect(issued.challengeXdr).toBeTruthy();
    expect(issued.networkPassphrase).toBe(Networks.TESTNET);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const signed = signChallenge(issued.challengeXdr, CLIENT);
    const verified = await verifyChallenge({
      signedChallengeXdr: signed,
      purpose: "login",
    });

    expect(verified).toBe(CLIENT_PUBLIC);
    const rows = h.db.tables().auth_challenges;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publicKey: CLIENT_PUBLIC,
      purpose: "login",
      status: "used",
    });
  });

  it("rejects a challenge signed by the wrong account", async () => {
    const issued = await issueChallenge({ publicKey: CLIENT_PUBLIC, purpose: "login" });

    const other = Keypair.random();
    const signed = signChallenge(issued.challengeXdr, other);

    await expect(
      verifyChallenge({ signedChallengeXdr: signed, purpose: "login" }),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("rejects replaying a consumed challenge", async () => {
    const issued = await issueChallenge({ publicKey: CLIENT_PUBLIC, purpose: "login" });
    const signed = signChallenge(issued.challengeXdr, CLIENT);

    await verifyChallenge({ signedChallengeXdr: signed, purpose: "login" });

    await expect(
      verifyChallenge({ signedChallengeXdr: signed, purpose: "login" }),
    ).rejects.toMatchObject({ code: "CHALLENGE_USED" });
  });

  it("rejects an expired challenge", async () => {
    const nonce = "1234567890";
    h.db = seedDb({
      authChallenges: [
        {
          id: "ch1",
          publicKey: CLIENT_PUBLIC,
          nonce,
          purpose: "login",
          status: "pending",
          expiresAt: new Date(Date.now() - 60_000),
        },
      ],
    });

    const challengeXdr = WebAuth.buildChallengeTx(
      Keypair.fromSecret(SERVER_SECRET),
      CLIENT_PUBLIC,
      "localhost",
      300,
      Networks.TESTNET,
      "localhost",
      nonce,
    );
    const signed = signChallenge(challengeXdr, CLIENT);

    await expect(
      verifyChallenge({ signedChallengeXdr: signed, purpose: "login" }),
    ).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects a challenge for the wrong purpose", async () => {
    const issued = await issueChallenge({ publicKey: CLIENT_PUBLIC, purpose: "link" });
    const signed = signChallenge(issued.challengeXdr, CLIENT);

    await expect(
      verifyChallenge({ signedChallengeXdr: signed, purpose: "login" }),
    ).rejects.toMatchObject({ code: "PURPOSE_MISMATCH" });
  });

  it("rejects an unknown challenge (nonce not issued)", async () => {
    const challengeXdr = WebAuth.buildChallengeTx(
      Keypair.fromSecret(SERVER_SECRET),
      CLIENT_PUBLIC,
      "localhost",
      300,
      Networks.TESTNET,
      "localhost",
      "999999999999",
    );
    const signed = signChallenge(challengeXdr, CLIENT);

    await expect(
      verifyChallenge({ signedChallengeXdr: signed, purpose: "login" }),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("rejects an invalid public key", async () => {
    await expect(
      issueChallenge({ publicKey: "MABC123", purpose: "login" }),
    ).rejects.toMatchObject({ code: "INVALID_PUBLIC_KEY" });
  });

  it("rejects the SEP-10 server key as a client", async () => {
    await expect(
      issueChallenge({ publicKey: SERVER_PUBLIC, purpose: "login" }),
    ).rejects.toMatchObject({ code: "SERVER_KEY" });
  });

  it("rejects custodial addresses", async () => {
    h.db = seedDb({
      stellarAccounts: [
        { id: "sa1", userId: "u1", publicKey: CLIENT_PUBLIC, encryptedSecret: "enc", status: "active" },
      ],
    });

    await expect(
      issueChallenge({ publicKey: CLIENT_PUBLIC, purpose: "login" }),
    ).rejects.toMatchObject({ code: "CUSTODIAL_KEY" });
  });

  it("rate-limits pending challenges per public key", async () => {
    const pending = Array.from({ length: 10 }, (_, i) => ({
      id: `ch${i}`,
      publicKey: CLIENT_PUBLIC,
      nonce: `nonce-${i}`,
      purpose: "login",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    }));
    h.db = seedDb({ authChallenges: pending });

    await expect(
      issueChallenge({ publicKey: CLIENT_PUBLIC, purpose: "login" }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });
});

describe("auth-stellar service — wallet links and login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.db = seedDb();
  });

  it("resolveStellarLogin creates a web user with a wallet link and a zero balance", async () => {
    const { user, isNewUser } = await resolveStellarLogin(CLIENT_PUBLIC);

    expect(isNewUser).toBe(true);
    expect(user.telegramId.startsWith("web-")).toBe(true);
    expect(user.firstName).toContain("…");

    const tables = h.db.tables();
    expect(tables.wallet_links).toHaveLength(1);
    expect(tables.wallet_links[0]).toMatchObject({
      userId: user.id,
      publicKey: CLIENT_PUBLIC,
      source: "stellar",
    });
    expect(tables.balances).toHaveLength(1);
    expect(tables.balances[0]).toMatchObject({ userId: user.id, amount: "0" });
  });

  it("resolveStellarLogin returns the existing user for a linked public key", async () => {
    h.db = seedDb({
      walletLinks: [
        { id: "wl1", userId: "u1", publicKey: CLIENT_PUBLIC, source: "stellar", verifiedAt: new Date() },
      ],
    });

    const { user, isNewUser } = await resolveStellarLogin(CLIENT_PUBLIC);

    expect(isNewUser).toBe(false);
    expect(user.id).toBe("u1");
    expect(h.db.tables().users).toHaveLength(1);
  });

  it("linkWallet stores a new verified link", async () => {
    const linked = await linkWallet("u1", CLIENT_PUBLIC);

    expect(linked).toBe(CLIENT_PUBLIC);
    expect(h.db.tables().wallet_links[0]).toMatchObject({
      userId: "u1",
      publicKey: CLIENT_PUBLIC,
    });
  });

  it("rejects linking a wallet that is already linked", async () => {
    h.db = seedDb({
      walletLinks: [
        { id: "wl1", userId: "u1", publicKey: CLIENT_PUBLIC, source: "stellar", verifiedAt: new Date() },
      ],
    });

    await expect(linkWallet("u1", CLIENT_PUBLIC)).rejects.toBeInstanceOf(WalletLinkError);
    await expect(linkWallet("u1", CLIENT_PUBLIC)).rejects.toMatchObject({
      code: "ALREADY_LINKED",
    });
  });

  it("rejects linking a custodial address", async () => {
    h.db = seedDb({
      stellarAccounts: [
        { id: "sa1", userId: "u1", publicKey: CLIENT_PUBLIC, encryptedSecret: "enc", status: "active" },
      ],
    });

    await expect(linkWallet("u1", CLIENT_PUBLIC)).rejects.toMatchObject({
      code: "CUSTODIAL_KEY",
    });
  });

  it("rejects linking the SEP-10 server key", async () => {
    await expect(linkWallet("u1", SERVER_PUBLIC)).rejects.toMatchObject({
      code: "CUSTODIAL_KEY",
    });
  });

  it("rejects an invalid address", async () => {
    await expect(linkWallet("u1", "not-an-address")).rejects.toMatchObject({
      code: "INVALID_ADDRESS",
    });
  });

  it("blocks unlink of the only wallet for a web-only user", async () => {
    h.db = seedDb({
      users: [
        { id: "w1", telegramId: "web-abc", telegramUsername: null, firstName: "G…X", role: "member" },
      ],
      walletLinks: [
        { id: "wl1", userId: "w1", publicKey: CLIENT_PUBLIC, source: "stellar", verifiedAt: new Date() },
      ],
    });

    await expect(unlinkWallet("w1", CLIENT_PUBLIC)).rejects.toMatchObject({
      code: "LAST_WALLET",
    });
  });

  it("allows unlink when the user has another wallet", async () => {
    const other = Keypair.random().publicKey();
    h.db = seedDb({
      users: [
        { id: "w1", telegramId: "web-abc", telegramUsername: null, firstName: "G…X", role: "member" },
      ],
      walletLinks: [
        { id: "wl1", userId: "w1", publicKey: CLIENT_PUBLIC, source: "stellar", verifiedAt: new Date() },
        { id: "wl2", userId: "w1", publicKey: other, source: "stellar", verifiedAt: new Date() },
      ],
    });

    await expect(unlinkWallet("w1", CLIENT_PUBLIC)).resolves.toEqual({ removed: true });
  });

  it("allows unlink for a Telegram user with a single wallet", async () => {
    h.db = seedDb({
      walletLinks: [
        { id: "wl1", userId: "u1", publicKey: CLIENT_PUBLIC, source: "stellar", verifiedAt: new Date() },
      ],
    });

    await expect(unlinkWallet("u1", CLIENT_PUBLIC)).resolves.toEqual({ removed: true });
  });

  it("throws NOT_FOUND when unlinking a wallet the user does not own", async () => {
    await expect(unlinkWallet("u1", CLIENT_PUBLIC)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists the user's wallet links", async () => {
    const other = Keypair.random().publicKey();
    h.db = seedDb({
      walletLinks: [
        { id: "wl1", userId: "u1", publicKey: CLIENT_PUBLIC, source: "stellar", verifiedAt: new Date() },
        { id: "wl2", userId: "u1", publicKey: other, source: "stellar", verifiedAt: new Date() },
      ],
    });

    const links = await listWalletLinks("u1");
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.publicKey).sort()).toEqual([CLIENT_PUBLIC, other].sort());
  });

  it("exposes typed error codes", () => {
    const challengeErr = new AuthChallengeError("x", "CHALLENGE_USED");
    expect(challengeErr.code).toBe("CHALLENGE_USED");
    const linkErr = new WalletLinkError("x", "ALREADY_LINKED");
    expect(linkErr.code).toBe("ALREADY_LINKED");
  });
});
