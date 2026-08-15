import { createPublicKey, verify } from "node:crypto";
import { parse, validate, type InitData } from "@tma.js/init-data-node";
import { env } from "@/lib/env";

export type { InitData, User, Chat } from "@tma.js/init-data-node";

const TELEGRAM_ED25519_PUBLIC_KEY = Buffer.from(
  "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d",
  "hex",
);

const INIT_DATA_MAX_AGE_MS = 86_400_000;

export class TelegramInitDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramInitDataError";
  }
}

export function parseTelegramInitData(initDataRaw: string): InitData {
  try {
    return parse(initDataRaw);
  } catch (error) {
    throw new TelegramInitDataError(error instanceof Error ? error.message : "Malformed initData");
  }
}

export function verifyTelegramSignature3rd(
  initDataRaw: string,
  botId: string,
  options?: { now?: number },
): boolean {
  const params = new URLSearchParams(initDataRaw);
  const pairs: string[] = [];
  let signature: string | undefined;
  let authDate: number | undefined;
  for (const [key, value] of params.entries()) {
    if (key === "hash") {
      continue;
    }
    if (key === "signature") {
      signature = value;
      continue;
    }
    if (key === "auth_date") {
      const parsedAuthDate = Number(value);
      if (!Number.isNaN(parsedAuthDate)) {
        authDate = parsedAuthDate;
      }
    }
    pairs.push(`${key}=${value}`);
  }
  if (!signature || authDate === undefined) {
    return false;
  }
  const now = options?.now ?? Date.now();
  if (authDate * 1000 + INIT_DATA_MAX_AGE_MS < now) {
    return false;
  }
  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: TELEGRAM_ED25519_PUBLIC_KEY.toString("base64url") },
      format: "jwk",
    });
    return verify(
      null,
      Buffer.from(`${botId}:WebAppData\n${pairs.sort().join("\n")}`),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function validateTelegramInitData(initDataRaw: string): InitData {
  const data = parseTelegramInitData(initDataRaw);
  try {
    validate(initDataRaw, env.TELEGRAM_BOT_TOKEN);
  } catch (error) {
    const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0];
    if (!verifyTelegramSignature3rd(initDataRaw, botId)) {
      throw new TelegramInitDataError(
        error instanceof Error ? `${error.name}: ${error.message}` : "Invalid initData signature",
      );
    }
  }
  return data;
}

export function getTelegramUserId(initData: InitData): string {
  if (!initData.user?.id) {
    throw new TelegramInitDataError("initData does not contain a user");
  }
  return String(initData.user.id);
}
