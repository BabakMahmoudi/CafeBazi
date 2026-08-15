import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";
import { existsSync } from "node:fs";

dotenv.config({ path: existsSync(".env.local") ? ".env.local" : ".env" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
