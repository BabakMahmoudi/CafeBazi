import { z } from "zod";
import { requestTelegramCode, TelegramCodeError } from "@/services/auth-telegram-code";

const bodySchema = z.object({
  username: z.string().trim().min(1).max(64),
});

export async function POST(req: Request) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }

    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }

    await requestTelegramCode({ username: parsed.data.username });

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof TelegramCodeError) {
      const status =
        error.code === "NOT_FOUND"
          ? 404
          : error.code === "RATE_LIMITED" ||
              error.code === "RESEND_COOLDOWN" ||
              error.code === "TOO_MANY_ATTEMPTS"
            ? 429
            : error.code === "BOT_NOT_STARTED"
              ? 409
              : error.code === "SEND_FAILED"
                ? 502
                : 400;
      return Response.json({ ok: false, error: error.code.toLowerCase() }, { status });
    }
    console.error("auth/telegram-code/request: server error", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
