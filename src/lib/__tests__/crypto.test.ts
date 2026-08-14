import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

describe("crypto (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const secret = "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const ciphertext = encryptSecret(secret);
    expect(ciphertext).not.toBe(secret);
    expect(decryptSecret(ciphertext)).toBe(secret);
  });

  it("produces unique ciphertexts for the same plaintext (random IV)", () => {
    const secret = "same-secret";
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("throws on tampered ciphertext", () => {
    const secret = "tamper-me";
    const ciphertext = encryptSecret(secret);
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws on a payload that is too short", () => {
    expect(() => decryptSecret("c2hvcnQ=")).toThrow();
  });
});
