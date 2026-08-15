import { z } from "zod";
import { createSessionToken, setSessionCookie } from "@/lib/auth";
import { getTelegramUserId, validateTelegramInitData } from "@/lib/telegram";
import { ensureStellarAccount, upsertUserFromTelegram } from "@/services/users";

const bodySchema = z.object({
  initData: z.string().min(1),
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

    let initData;
    try {
      initData = validateTelegramInitData(parsed.data.initData);
    } catch (error) {
      console.error("auth/tma: invalid initData", error);
      return Response.json({ ok: false, error: "invalid_init_data" }, { status: 401 });
    }

    const telegramId = getTelegramUserId(initData);

    const user = await upsertUserFromTelegram({
      id: Number(telegramId),
      username: initData.user?.username,
      firstName: initData.user?.first_name ?? "",
      lastName: initData.user?.last_name,
    });

    const account = await ensureStellarAccount(user.id);

    const token = await createSessionToken({
      sub: user.id,
      telegramId: user.telegramId,
      role: user.role,
    });
    await setSessionCookie(token);

    return Response.json({
      ok: true,
      user: { id: user.id, role: user.role },
      accountStatus: account.status,
    });
  } catch (error) {
    console.error("auth/tma: server error", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
