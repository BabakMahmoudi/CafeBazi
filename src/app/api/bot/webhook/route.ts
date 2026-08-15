import { handleUpdate, verifyWebhookSecret, type TgUpdate } from "@/services/bot";

export async function POST(req: Request) {
  console.log("Webhook POST request received");
  return Response.json({ ok: true });
  if (!verifyWebhookSecret(req)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  await handleUpdate(update);
  return Response.json({ ok: true });
}
