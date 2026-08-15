import { describe, expect, it } from "vitest";
import { getAccountBalance, takBalanceFromHorizon } from "@/services/stellar";

const ISSUER_ACCOUNT = "GD34LHPQRSZKJGTDSTAFHLTJ4AOS77JEAVMXVITLEI2XYCNSH64SIGRM";

describe("stellar — TAK balance extraction", () => {
  it("returns 0n when the account holds no TAK trustline", () => {
    const balances = [
      { asset_type: "native", balance: "14317.5075160" },
      { asset_type: "credit_alphanum4", asset_code: "USD", asset_issuer: "GABC", balance: "5.0000000" },
    ];

    expect(takBalanceFromHorizon(balances, ISSUER_ACCOUNT)).toBe(0n);
  });

  it("returns the whole-TAK part of the on-chain balance", () => {
    const balances = [
      { asset_type: "credit_alphanum4", asset_code: "TAK", asset_issuer: ISSUER_ACCOUNT, balance: "42.9000000" },
    ];

    expect(takBalanceFromHorizon(balances, ISSUER_ACCOUNT)).toBe(42n);
  });

  it("parses the decimal string directly instead of rounding through float", () => {
    const balances = [
      { asset_type: "credit_alphanum4", asset_code: "TAK", asset_issuer: ISSUER_ACCOUNT, balance: "5000000000.9999999" },
    ];

    expect(takBalanceFromHorizon(balances, ISSUER_ACCOUNT)).toBe(5000000000n);
  });
});

describe.runIf(process.env.RUN_LIVE === "1")("stellar — live testnet balance", () => {
  it(`calculates the on-chain TAK balance of ${ISSUER_ACCOUNT} (token contract)`, async () => {
    const balance = await getAccountBalance(ISSUER_ACCOUNT);

    expect(balance).toBe(999992n);
  }, 30_000);
});
