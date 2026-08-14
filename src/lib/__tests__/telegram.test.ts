import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sign } from "@tma.js/init-data-node";
import {
  getTelegramUserId,
  parseTelegramInitData,
  TelegramInitDataError,
  validateTelegramInitData,
} from "@/lib/telegram";

const BOT_TOKEN = "123456789:AA_TELEGRAM_BOT_TEST_TOKEN";

function makeUser() {
  return {
    id: 42,
    first_name: "Ali",
    last_name: "Rezaei",
    username: "ali",
    language_code: "fa",
  };
}

function makeSignedInitData(): string {
  return sign({ query_id: "AAG9lQ0_AAAAAL2VDT8", user: makeUser() }, BOT_TOKEN, new Date());
}

function withAuthDate(authDateSeconds: number): string {
  const params = new URLSearchParams(makeSignedInitData());
  params.set("auth_date", String(authDateSeconds));
  const pairs = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(pairs.join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("telegram initData validation", () => {
  it("parses a valid signed initData", () => {
    const initData = validateTelegramInitData(makeSignedInitData());
    expect(initData.user?.id).toBe(42);
    expect(getTelegramUserId(initData)).toBe("42");
  });

  it("rejects a tampered payload", () => {
    const params = new URLSearchParams(makeSignedInitData());
    const user = JSON.parse(params.get("user") ?? "{}") as { first_name: string };
    user.first_name = "Hack";
    params.set("user", JSON.stringify(user));
    expect(() => validateTelegramInitData(params.toString())).toThrow(TelegramInitDataError);
  });

  it("rejects an expired auth_date", () => {
    const stale = withAuthDate(Math.floor(Date.now() / 1000) - 200_000);
    expect(() => validateTelegramInitData(stale)).toThrow(TelegramInitDataError);
  });

  it("throws on malformed input", () => {
    expect(() => parseTelegramInitData("not-a-query")).toThrow(TelegramInitDataError);
  });

  it("throws when the user is missing", () => {
    const signed = sign({ query_id: "x" }, BOT_TOKEN, new Date());
    const initData = parseTelegramInitData(signed);
    expect(() => getTelegramUserId(initData)).toThrow(TelegramInitDataError);
  });
});
