import "server-only";
import { env } from "@/lib/env";

export const TAK_ASSET_CODE = "TAK";

const TAK_DECIMALS = 10n ** 7n;

const CONTRACT_BALANCE_KEY = (s: StellarSdk, publicKey: string) =>
  s.xdr.ScVal.scvVec([
    s.xdr.ScVal.scvSymbol("Balance"),
    new s.Address(publicKey).toScVal(),
  ]);

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

export async function isValidStellarAddress(address: string): Promise<boolean> {
  const s = await sdk();
  return s.StrKey.isValidEd25519PublicKey(address);
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

async function buildSignedContractTransfer(
  s: StellarSdk,
  sourceSecretKey: string,
  destination: string,
  amount: string,
): Promise<SignedPayment> {
  const source = s.Keypair.fromSecret(sourceSecretKey);
  const server = new s.Horizon.Server(env.HORIZON_URL);
  const rpcServer = new s.rpc.Server(env.SOROBAN_RPC_URL);
  const account = await server.loadAccount(source.publicKey());
  const stroops = BigInt(amount) * TAK_DECIMALS;

  const operation = s.Operation.invokeContractFunction({
    contract: env.TAK_CONTRACT_ID,
    function: "transfer",
    args: [
      new s.Address(source.publicKey()).toScVal(),
      new s.Address(destination).toScVal(),
      s.nativeToScVal(stroops, { type: "i128" }),
    ],
  });

  const transaction = new s.TransactionBuilder(account, {
    fee: s.BASE_FEE,
    networkPassphrase: await getNetworkPassphrase(),
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();

  const simulation = await rpcServer.simulateTransaction(transaction);
  const assembled = s.rpc.assembleTransaction(transaction, simulation).build();
  assembled.sign(source);

  return {
    envelopeXdr: assembled.toXDR(),
    txHash: assembled.hash().toString("hex"),
  };
}

export async function buildSignedPayment(input: {
  sourceSecretKey: string;
  destination: string;
  amount: string;
  memo?: string;
}): Promise<SignedPayment> {
  const s = await sdk();

  if (env.TAK_CONTRACT_ID) {
    return buildSignedContractTransfer(s, input.sourceSecretKey, input.destination, input.amount);
  }

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
  const transaction = new s.Transaction(envelopeXdr, await getNetworkPassphrase());
  const isSoroban = transaction.operations.some(
    (op) =>
      op.type === "invokeHostFunction" || op.type === "extendFootprintTtl" || op.type === "restoreFootprint",
  );

  if (!isSoroban) {
    const server = new s.Horizon.Server(env.HORIZON_URL);
    const result = await server.submitTransaction(transaction);
    return result.hash;
  }

  const rpcServer = new s.rpc.Server(env.SOROBAN_RPC_URL);
  const sent = await rpcServer.sendTransaction(transaction);
  if (sent.status === "ERROR") {
    throw new Error("transaction rejected by the network");
  }
  const result = await rpcServer.pollTransaction(sent.hash, {
    attempts: 30,
    sleepStrategy: () => 1_000,
  });
  if (result.status === "FAILED") {
    throw new Error("transaction failed on chain");
  }
  return sent.hash;
}

export type HorizonTxStatus = "confirmed" | "failed" | "unknown";

export async function getTransactionStatus(txHash: string): Promise<HorizonTxStatus> {
  const s = await sdk();
  try {
    const rpcServer = new s.rpc.Server(env.SOROBAN_RPC_URL);
    const tx = await rpcServer.getTransaction(txHash);
    if (tx.status === "SUCCESS") {
      return "confirmed";
    }
    if (tx.status === "FAILED") {
      return "failed";
    }
  } catch {
    // fall through to Horizon
  }
  try {
    const server = new s.Horizon.Server(env.HORIZON_URL);
    const tx = await server.transactions().transaction(txHash).call();
    return tx.successful ? "confirmed" : "failed";
  } catch {
    return "unknown";
  }
}

export type HorizonBalanceEntry = {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
};

export function takBalanceFromHorizon(
  balances: ReadonlyArray<HorizonBalanceEntry>,
  issuerPublicKey: string,
): bigint {
  const entry = balances.find(
    (b) => b.asset_code === TAK_ASSET_CODE && b.asset_issuer === issuerPublicKey,
  );
  if (!entry) {
    return 0n;
  }
  const wholeTak = entry.balance.split(".")[0];
  return BigInt(wholeTak);
}

export async function getContractTakBalance(publicKey: string): Promise<bigint | null> {
  if (!env.TAK_CONTRACT_ID) {
    return null;
  }
  const s = await sdk();
  const server = new s.rpc.Server(env.SOROBAN_RPC_URL);
  try {
    const result = await server.getContractData(
      env.TAK_CONTRACT_ID,
      CONTRACT_BALANCE_KEY(s, publicKey),
      s.rpc.Durability.Persistent,
    );
    const value = result.val.contractData().val();
    if (value.switch().name !== "scvI128") {
      return null;
    }
    const i128 = value.i128();
    const stroops = i128.hi().toBigInt() * (1n << 64n) + i128.lo().toBigInt();
    return stroops / TAK_DECIMALS;
  } catch {
    return null;
  }
}

export async function getAccountBalance(publicKey: string): Promise<bigint> {
  const contractBalance = await getContractTakBalance(publicKey);
  if (contractBalance !== null) {
    return contractBalance;
  }
  try {
    const s = await sdk();
    const server = new s.Horizon.Server(env.HORIZON_URL);
    const account = await server.loadAccount(publicKey);
    return takBalanceFromHorizon(account.balances, getIssuerPublicKey());
  } catch {
    return 0n;
  }
}
