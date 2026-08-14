import { parse, validate, type InitData } from "@tma.js/init-data-node";
import { env } from "@/lib/env";

export type { InitData, User, Chat } from "@tma.js/init-data-node";

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

export function validateTelegramInitData(initDataRaw: string): InitData {
  const data = parseTelegramInitData(initDataRaw);
  try {
    validate(initDataRaw, env.TELEGRAM_BOT_TOKEN);
  } catch (error) {
    throw new TelegramInitDataError(error instanceof Error ? error.message : "Invalid initData signature");
  }
  return data;
}

export function getTelegramUserId(initData: InitData): string {
  if (!initData.user?.id) {
    throw new TelegramInitDataError("initData does not contain a user");
  }
  return String(initData.user.id);
}
