import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sign } from "@tma.js/init-data-node";
import {
  getTelegramUserId,
  parseTelegramInitData,
  TelegramInitDataError,
  validateTelegramInitData,
  verifyTelegramSignature3rd,
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

describe("third-party initData signature (Telegram public key)", () => {
  const docsExample =
    "user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%20%2B%20-%20%3F%20%5C%2F%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%2C%22allows_write_to_pm%22%3Atrue%2C%22photo_url%22%3A%22https%3A%5C%2F%5C%2Ft.me%5C%2Fi%5C%2Fuserpic%5C%2F320%5C%2F4FPEE4tmP3ATHa57u6MqTDih13LTOiMoKoLDRG4PnSA.svg%22%7D&chat_instance=8134722200314281151&chat_type=private&auth_date=1733584787&hash=2174df5b000556d044f3f020384e879c8efcab55ddea2ced4eb752e93e7080d6&signature=zL-ucjNyREiHDE8aihFwpfR9aggP2xiAo3NSpfe-p7IbCisNlDKlo7Kb6G4D0Ao2mBrSgEk4maLSdv6MLIlADQ";

  it("accepts a signature issued by the matching bot", () => {
    expect(
      verifyTelegramSignature3rd(docsExample, "7342037359", { now: 1733584787 * 1000 }),
    ).toBe(true);
  });

  it("rejects a signature issued by another bot", () => {
    expect(verifyTelegramSignature3rd(docsExample, "123456789")).toBe(false);
  });

  it("rejects init data without a signature", () => {
    expect(verifyTelegramSignature3rd(makeSignedInitData(), "123456789")).toBe(false);
  });
});
