import { z } from "zod";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { AuthPasswordError, signinWithPassword } from "@/services/auth-password";
import { getStellarAccountByUserId } from "@/services/users";

const bodySchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
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

    const { user } = await signinWithPassword({
      username: parsed.data.username,
      password: parsed.data.password,
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
    if (error instanceof AuthPasswordError) {
      const status =
        error.code === "INVALID_CREDENTIALS"
          ? 401
          : error.code === "ACCOUNT_LOCKED"
            ? 429
            : 400;
      return Response.json({ ok: false, error: error.code.toLowerCase() }, { status });
    }
    console.error("auth/password/signin: server error", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
