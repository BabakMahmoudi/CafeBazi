import "server-only";
import { env } from "@/lib/env";

export const TAK_ASSET_CODE = "TAK";

type StellarSdk = typeof import("@stellar/stellar-sdk");

let sdkPromise: Promise<StellarSdk> | null = null;

function sdk(): Promise<StellarSdk> {
  if (!sdkPromise) {
    sdkPromise = import("@stellar/stellar-sdk");
  }
  return sdkPromise;
}

export async function getNetworkPassphrase(): Promise<string> {
  const s = await sdk();
  return env.STELLAR_NETWORK === "testnet" ? s.Networks.TESTNET : s.Networks.PUBLIC;
}

export function getIssuerPublicKey(): string {
  return env.TAK_ISSUER_PUBLIC_KEY;
}

export async function generateKeypair(): Promise<{ publicKey: string; secretKey: string }> {
  const s = await sdk();
  const keypair = s.Keypair.random();
  return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

export async function createFundedAccount(publicKey: string): Promise<void> {
  if (env.STELLAR_NETWORK !== "testnet") {
    throw new Error("createFundedAccount is only available on the Stellar testnet (Friendbot)");
  }
  const s = await sdk();
  const server = new s.Horizon.Server(env.HORIZON_URL);
  try {
    await server.loadAccount(publicKey);
    return;
  } catch {
    await server.friendbot(publicKey).call();
  }
}

export type SignedPayment = {
  envelopeXdr: string;
  txHash: string;
};

export async function buildSignedPayment(input: {
  sourceSecretKey: string;
  destination: string;
  amount: string;
  memo?: string;
}): Promise<SignedPayment> {
  const s = await sdk();
  const source = s.Keypair.fromSecret(input.sourceSecretKey);
  const server = new s.Horizon.Server(env.HORIZON_URL);
  const account = await server.loadAccount(source.publicKey());

  const memoText = input.memo?.trim();
  if (memoText && Buffer.byteLength(memoText, "utf8") > 28) {
    throw new Error("memo must be at most 28 bytes");
  }

  const asset = new s.Asset(TAK_ASSET_CODE, getIssuerPublicKey());
  const transaction = new s.TransactionBuilder(account, {
    fee: s.BASE_FEE,
    networkPassphrase: await getNetworkPassphrase(),
    memo: memoText ? s.Memo.text(memoText) : undefined,
  })
    .addOperation(
      s.Operation.payment({
        destination: input.destination,
        asset,
        amount: input.amount,
      }),
    )
    .setTimeout(180)
    .build();

  transaction.sign(source);

  return {
    envelopeXdr: transaction.toXDR(),
    txHash: transaction.hash().toString("hex"),
  };
}

export async function addTrustline(input: {
  sourceSecretKey: string;
  issuerPublicKey: string;
}): Promise<SignedPayment> {
  const s = await sdk();
  const source = s.Keypair.fromSecret(input.sourceSecretKey);
  const server = new s.Horizon.Server(env.HORIZON_URL);
  const account = await server.loadAccount(source.publicKey());

  const asset = new s.Asset(TAK_ASSET_CODE, input.issuerPublicKey);
  const transaction = new s.TransactionBuilder(account, {
    fee: s.BASE_FEE,
    networkPassphrase: await getNetworkPassphrase(),
  })
    .addOperation(
      s.Operation.changeTrust({
        asset,
      }),
    )
    .setTimeout(180)
    .build();

  transaction.sign(source);

  return {
    envelopeXdr: transaction.toXDR(),
    txHash: transaction.hash().toString("hex"),
  };
}

export async function ensureTakTrustline(sourceSecretKey: string): Promise<boolean> {
  const s = await sdk();
  const source = s.Keypair.fromSecret(sourceSecretKey);
  const server = new s.Horizon.Server(env.HORIZON_URL);
  const account = await server.loadAccount(source.publicKey());
  const hasTrustline = account.balances.some(
    (entry) =>
      "asset_code" in entry &&
      entry.asset_code === TAK_ASSET_CODE &&
      entry.asset_issuer === getIssuerPublicKey(),
  );
  if (hasTrustline) {
    return false;
  }
  const trustline = await addTrustline({
    sourceSecretKey,
    issuerPublicKey: getIssuerPublicKey(),
  });
  await submitEnvelope(trustline.envelopeXdr);
  return true;
}

export async function submitEnvelope(envelopeXdr: string): Promise<string> {
  const s = await sdk();
  const server = new s.Horizon.Server(env.HORIZON_URL);
  const transaction = new s.Transaction(envelopeXdr, await getNetworkPassphrase());
  const result = await server.submitTransaction(transaction);
  return result.hash;
}

export type HorizonTxStatus = "confirmed" | "failed" | "unknown";

export async function getTransactionStatus(txHash: string): Promise<HorizonTxStatus> {
  const s = await sdk();
  const server = new s.Horizon.Server(env.HORIZON_URL);
  try {
    const tx = await server.transactions().transaction(txHash).call();
    return tx.successful ? "confirmed" : "failed";
  } catch {
    return "unknown";
  }
}

export async function getAccountBalance(publicKey: string): Promise<bigint> {
  const s = await sdk();
  const server = new s.Horizon.Server(env.HORIZON_URL);
  const account = await server.loadAccount(publicKey);
  const balance = account.balances.find(
    (entry) => "asset_code" in entry && entry.asset_code === TAK_ASSET_CODE,
  );
  return balance ? BigInt(Math.trunc(Number(balance.balance))) : 0n;
}
