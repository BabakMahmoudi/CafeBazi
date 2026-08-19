import { z } from "zod";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { AuthChallengeError, resolveStellarLogin, verifyChallenge } from "@/services/auth-stellar";

const bodySchema = z.object({
  signedChallengeXdr: z.string().min(1),
  purpose: z.literal("login").default("login"),
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

    const publicKey = await verifyChallenge({
      signedChallengeXdr: parsed.data.signedChallengeXdr,
      purpose: parsed.data.purpose,
    });

    const { user, isNewUser } = await resolveStellarLogin(publicKey);

    const token = await createSessionToken({
      sub: user.id,
      telegramId: user.telegramId,
      role: user.role,
    });
    await setSessionCookie(token);

    return Response.json({
      ok: true,
      user: { id: user.id, role: user.role },
      isNewUser,
    });
  } catch (error) {
    if (error instanceof AuthChallengeError) {
      return Response.json({ ok: false, error: error.code.toLowerCase() }, { status: 400 });
    }
    console.error("auth/stellar/verify: server error", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
