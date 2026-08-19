import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery staple");

    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");

    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("derives a unique salt per hash", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);

    expect(first).not.toBe(second);
  });

  it("rejects malformed stored hashes", async () => {
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt$1$1$1$zz$xx$extra")).resolves.toBe(false);
    await expect(verifyPassword("anything", "md5$16384$8$1$abcd$abcd")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt$0$8$1$abcd$abcd")).resolves.toBe(false);
  });
});
