import { z } from "zod";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { AuthPasswordError, signupWithPassword } from "@/services/auth-password";
import { findTelegramLinkedUserByUsername } from "@/services/auth-telegram-code";

const bodySchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request) {
  let rawUsername = "";
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
    rawUsername = parsed.data.username;

    const { user, accountStatus } = await signupWithPassword({
      username: parsed.data.username,
      password: parsed.data.password,
    });

    const token = await createSessionToken({
      sub: user.id,
      telegramId: user.telegramId,
      role: user.role,
    });
    await setSessionCookie(token);

    return Response.json({
      ok: true,
      user: { id: user.id, role: user.role },
      accountStatus,
    });
  } catch (error) {
    if (error instanceof AuthPasswordError) {
      if (error.code === "USERNAME_TAKEN") {
        const telegramUser = await findTelegramLinkedUserByUsername(rawUsername);
        return Response.json(
          telegramUser
            ? { ok: false, error: "username_taken", codeLoginAvailable: true }
            : { ok: false, error: "username_taken" },
          { status: 409 },
        );
      }
      const status =
        error.code === "ACCOUNT_LOCKED"
          ? 429
          : 400;
      return Response.json({ ok: false, error: error.code.toLowerCase() }, { status });
    }
    console.error("auth/password/signup: server error", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
