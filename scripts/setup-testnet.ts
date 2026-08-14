import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const ISSUER_CODE = "TAK";
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const FILE = path.resolve(process.cwd(), ".env.testnet.json");

type TestnetKeys = {
  issuer: { publicKey: string; secretKey: string };
  funding: { publicKey: string; secretKey: string };
  lotteryPool: { publicKey: string; secretKey: string };
};

function loadExisting(): TestnetKeys | null {
  if (!existsSync(FILE)) return null;
  return JSON.parse(readFileSync(FILE, "utf8")) as TestnetKeys;
}

function createKeys(): TestnetKeys {
  const make = () => {
    const kp = Keypair.random();
    return { publicKey: kp.publicKey(), secretKey: kp.secret() };
  };
  return { issuer: make(), funding: make(), lotteryPool: make() };
}

async function fund(server: Horizon.Server, publicKey: string) {
  await server.friendbot(publicKey).call();
}

async function submit(server: Horizon.Server,
  secretKey: string,
  operations: Array<ReturnType<typeof Operation.payment> | ReturnType<typeof Operation.changeTrust>>,
  memo?: string,
) {
  const source = Keypair.fromSecret(secretKey);
  const account = await server.loadAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
    memo: memo ? Memo.text(memo) : undefined,
  })
    .addOperation(operations[0])
    .setTimeout(180)
    .build();
  tx.sign(source);
  await server.submitTransaction(tx);
}

async function main() {
  if ((process.env.STELLAR_NETWORK ?? "testnet") !== "testnet") {
    throw new Error("setup-testnet only runs against the Stellar testnet");
  }

  const keys = loadExisting() ?? createKeys();
  const server = new Horizon.Server(HORIZON_URL);

  console.log("Funding ISSUER/FUNDING/LOTTERY_POOL via Friendbot...");
  await fund(server, keys.issuer.publicKey);
  await fund(server, keys.funding.publicKey);
  await fund(server, keys.lotteryPool.publicKey);

  const tak = new Asset(ISSUER_CODE, keys.issuer.publicKey);

  console.log("Adding TAK trustlines...");
  await submit(server, keys.funding.secretKey, [Operation.changeTrust({ asset: tak })]);
  await submit(server, keys.lotteryPool.secretKey, [Operation.changeTrust({ asset: tak })]);

  console.log("Issuing TAK to FUNDING (100000) and LOTTERY_POOL (10000)...");
  await submit(
    server,
    keys.issuer.secretKey,
    [
      Operation.payment({
        destination: keys.funding.publicKey,
        asset: tak,
        amount: "100000",
      }),
    ],
    "initial supply",
  );
  await submit(
    server,
    keys.issuer.secretKey,
    [
      Operation.payment({
        destination: keys.lotteryPool.publicKey,
        asset: tak,
        amount: "10000",
      }),
    ],
    "lottery pool",
  );

  writeFileSync(FILE, JSON.stringify(keys, null, 2), "utf8");
  console.log(`Wrote ${FILE} (gitignored).`);
  console.log(`TAK issuer public key: ${keys.issuer.publicKey}`);
  console.log("Add TAK_ISSUER_PUBLIC_KEY to your env, then run pnpm db:seed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
