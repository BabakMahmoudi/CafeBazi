import { z } from "zod";
import { AuthChallengeError, issueChallenge } from "@/services/auth-stellar";

const bodySchema = z.object({
  publicKey: z.string().trim().min(1).max(56),
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

    const result = await issueChallenge({
      publicKey: parsed.data.publicKey,
      purpose: parsed.data.purpose,
    });

    return Response.json({
      ok: true,
      challengeXdr: result.challengeXdr,
      networkPassphrase: result.networkPassphrase,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof AuthChallengeError) {
      return Response.json({ ok: false, error: error.code.toLowerCase() }, { status: 400 });
    }
    console.error("auth/stellar/challenge: server error", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
