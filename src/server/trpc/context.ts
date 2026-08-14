import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type UserRole } from "@/db/schema";
import { getSessionToken, verifySessionToken } from "@/lib/auth";

export type SessionUser = {
  id: string;
  telegramId: string;
  role: UserRole;
};

export type Context = {
  user: SessionUser | null;
};

export async function createTRPCContext(opts: { req: Request }): Promise<Context> {
  void opts;
  let user: SessionUser | null = null;
  try {
    const token = await getSessionToken();
    if (token) {
      const payload = await verifySessionToken(token);
      const rows = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
      if (rows[0]) {
        user = {
          id: rows[0].id,
          telegramId: rows[0].telegramId,
          role: rows[0].role as UserRole,
        };
      }
    }
  } catch {
    user = null;
  }
  return { user };
}
