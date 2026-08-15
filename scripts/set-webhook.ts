import dotenv from "dotenv";
import { existsSync } from "node:fs";

dotenv.config({ path: existsSync(".env.local") ? ".env.local" : ".env" });
import { setWebhook } from "@/lib/telegram-api";

async function main() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.TELEGRAM_BOT_TOKEN;
  if (!baseUrl || !secret) {
    throw new Error("NEXT_PUBLIC_APP_URL and TELEGRAM_BOT_TOKEN are required");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/bot/webhook`;
  console.log(`Trying Webhook registered: ${url}`);
  await setWebhook({ url, secretToken: secret });
  console.log(`Webhook registered: ${url}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
