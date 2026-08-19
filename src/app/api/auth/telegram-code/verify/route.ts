import { z } from "zod";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { verifyTelegramCode, TelegramCodeError } from "@/services/auth-telegram-code";
import { getStellarAccountByUserId } from "@/services/users";

const bodySchema = z.object({
  username: z.string().trim().min(1).max(64),
  code: z.string().regex(/^\d{6}$/),
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

    const { user } = await verifyTelegramCode({
      username: parsed.data.username,
      code: parsed.data.code,
    });

    const account = await getStellarAccountByUserId(user.id);

    const token = await createSessionToken({
      sub: user.id,
      telegramId: user.telegramId,
      role: user.role,
    });
    await setSessionCookie(token);

    return Response.json({
      ok: true,
      user: { id: user.id, role: user.role },
      accountStatus: account?.status ?? "pending_funding",
    });
  } catch (error) {
    if (error instanceof TelegramCodeError) {
      const status =
        error.code === "INVALID_CODE" || error.code === "CODE_EXPIRED"
          ? 401
          : error.code === "TOO_MANY_ATTEMPTS"
            ? 429
            : 400;
      return Response.json({ ok: false, error: error.code.toLowerCase() }, { status });
    }
    console.error("auth/telegram-code/verify: server error", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
