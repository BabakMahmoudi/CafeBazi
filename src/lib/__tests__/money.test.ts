import { describe, expect, it } from "vitest";
import {
  numericToTak,
  takFromNumeric,
  takToNumeric,
  takToNumericSchema,
} from "@/lib/money";

describe("money (bigint <-> numeric)", () => {
  it("converts numeric strings to bigint", () => {
    expect(takFromNumeric("0")).toBe(0n);
    expect(takFromNumeric("42")).toBe(42n);
    expect(takFromNumeric("99999999999999999999")).toBe(99999999999999999999n);
  });

  it("converts bigint to numeric strings", () => {
    expect(takToNumeric(0n)).toBe("0");
    expect(takToNumeric(42n)).toBe("42");
  });

  it("round-trips through the zod transforms", () => {
    const db = "37";
    const tak = numericToTak.parse(db);
    expect(tak).toBe(37n);
    expect(takToNumericSchema.parse(tak)).toBe("37");
  });
});
