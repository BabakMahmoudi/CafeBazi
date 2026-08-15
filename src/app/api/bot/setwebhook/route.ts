import { env } from "@/lib/env";
import { setWebhook } from "@/lib/telegram-api";

export async function GET() {
  const baseUrl = env.NEXT_PUBLIC_APP_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/api/bot/webhook`;
  try {
    var tok = env.TELEGRAM_BOT_TOKEN;
    console.log(`Trying Webhook registered: ${url} ${tok}`);
    
    console.log(`Trying Webhook registered: ${url} ${tok} ** ${env.TELEGRAM_BOT_TOKEN}`);
    await setWebhook({ url, secretToken: tok});
    return Response.json({ ok: true, url });
  } catch (error) {
    console.error(`Webhook registration failed: ${url}`, error);
    return Response.json({ ok: false, url, error: error instanceof Error ? error.message : String(error) });
  }
}
