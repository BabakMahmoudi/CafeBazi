import "server-only";
import { and, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { contacts, users } from "@/db/schema";

const RECENTS_LIMIT = 10;
const SEARCH_LIMIT = 10;

export async function getRecipientPicker(userId: string, query?: string) {
  const contactRows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .orderBy(desc(contacts.lastUsedAt))
    .limit(RECENTS_LIMIT);

  const contactIds = contactRows.map((row) => row.contactUserId);
  const contactUsers =
    contactIds.length > 0
      ? await db.select().from(users).where(inArray(users.id, contactIds)).limit(SEARCH_LIMIT)
      : [];

  const recents = contactRows
    .map((row) => {
      const contactUser = contactUsers.find((u) => u.id === row.contactUserId);
      if (!contactUser) return null;
      return {
        userId: contactUser.id,
        telegramUsername: contactUser.telegramUsername,
        firstName: contactUser.firstName,
        nickname: row.nickname,
        lastUsedAt: row.lastUsedAt,
      };
    })
    .filter((entry) => entry !== null);

  const trimmed = query?.trim();
  const search =
    trimmed && trimmed.length > 0
      ? await db
          .select()
          .from(users)
          .where(
            and(
              ne(users.id, userId),
              or(
                ilike(users.telegramUsername, `%${trimmed}%`),
                ilike(users.firstName, `%${trimmed}%`),
              ),
            ),
          )
          .limit(SEARCH_LIMIT)
      : [];

  return {
    recents,
    search: search.map((u) => ({
      userId: u.id,
      telegramUsername: u.telegramUsername,
      firstName: u.firstName,
    })),
  };
}
