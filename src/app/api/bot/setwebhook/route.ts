import { env } from "@/lib/env";
import { setWebhook } from "@/lib/telegram-api";

export async function GET() {
  const baseUrl = env.NEXT_PUBLIC_APP_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/api/bot/webhook`;
  try {
    const secretToken = env.WEBHOOK_SECRET_TOKEN;
    if (!secretToken) {
      throw new Error("WEBHOOK_SECRET_TOKEN is not set");
    }
    await setWebhook({ url, secretToken });
    return Response.json({ ok: true, url });
  } catch (error) {
    console.error(`Webhook registration failed: ${url}`, error);
    return Response.json({ ok: false, url, error: error instanceof Error ? error.message : String(error) });
  }
}
