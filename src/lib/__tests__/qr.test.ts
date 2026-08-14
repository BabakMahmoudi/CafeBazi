import { describe, expect, it } from "vitest";
import { buildStartAppUrl, buildStartParam, parseStartParam } from "@/lib/qr";

describe("qr start_param parsing", () => {
  it("parses a shop-only payload", () => {
    expect(parseStartParam("s3")).toEqual({ shopId: "3", table: undefined });
  });

  it("parses a shop+table payload", () => {
    expect(parseStartParam("s3t2")).toEqual({ shopId: "3", table: "2" });
  });

  it("rejects invalid payloads", () => {
    expect(parseStartParam("")).toBeNull();
    expect(parseStartParam("x3")).toBeNull();
    expect(parseStartParam("s")).toBeNull();
    expect(parseStartParam("s3t")).toBeNull();
    expect(parseStartParam("purchase")).toBeNull();
  });

  it("round-trips build -> parse", () => {
    expect(parseStartParam(buildStartParam({ shopId: "7" }))).toEqual({
      shopId: "7",
      table: undefined,
    });
    expect(parseStartParam(buildStartParam({ shopId: "7", table: "9" }))).toEqual({
      shopId: "7",
      table: "9",
    });
  });

  it("builds t.me deep links", () => {
    expect(buildStartAppUrl("@cafe_bazi_bot", { shopId: "3", table: "2" })).toBe(
      "https://t.me/cafe_bazi_bot?startapp=s3t2",
    );
    expect(buildStartAppUrl("cafe_bazi_bot", { shopId: "1" })).toBe(
      "https://t.me/cafe_bazi_bot?startapp=s1",
    );
  });
});
