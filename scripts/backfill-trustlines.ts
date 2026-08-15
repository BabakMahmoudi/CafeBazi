import dotenv from "dotenv";
import { existsSync } from "node:fs";

dotenv.config({ path: existsSync(".env.local") ? ".env.local" : ".env" });
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stellarAccounts } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { createFundedAccount, ensureTakTrustline } from "@/services/stellar";

async function main() {
  const rows = await db.select().from(stellarAccounts);
  let added = 0;
  let alreadyTrusted = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const row of rows) {
    try {
      const secretKey = decryptSecret(row.encryptedSecret);
      if (row.status !== "active") {
        try {
          await createFundedAccount(row.publicKey);
        } catch (error) {
          console.error(
            `  funding ${row.publicKey}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const changed = await ensureTakTrustline(secretKey);
      if (changed) {
        added += 1;
      } else {
        alreadyTrusted += 1;
      }
      if (row.status !== "active") {
        await db
          .update(stellarAccounts)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(stellarAccounts.id, row.id));
      }
    } catch (error) {
      failed += 1;
      failures.push(`${row.publicKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `Trustline backfill: ${added} added, ${alreadyTrusted} already trusted, ${failed} failed (${rows.length} total).`,
  );
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
