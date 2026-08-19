import "server-only";
import { and, desc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { contacts, stellarAccounts, users, walletLinks } from "@/db/schema";

const RECENTS_LIMIT = 10;
const SEARCH_LIMIT = 10;

type RecipientView = {
  userId: string;
  telegramUsername: string | null;
  firstName: string;
  paysToExternal: boolean;
};

function toRecipientView(
  user: typeof users.$inferSelect,
  linkedUserIds: Set<string>,
  activeAccountUserIds: Set<string>,
): RecipientView {
  return {
    userId: user.id,
    telegramUsername: user.telegramUsername,
    firstName: user.firstName,
    paysToExternal: linkedUserIds.has(user.id) && !activeAccountUserIds.has(user.id),
  };
}

async function externalFlags(userIds: string[]): Promise<{
  linkedUserIds: Set<string>;
  activeAccountUserIds: Set<string>;
}> {
  if (userIds.length === 0) {
    return { linkedUserIds: new Set(), activeAccountUserIds: new Set() };
  }
  const [linkRows, accountRows] = await Promise.all([
    db.select().from(walletLinks).where(inArray(walletLinks.userId, userIds)),
    db.select().from(stellarAccounts).where(inArray(stellarAccounts.userId, userIds)),
  ]);
  return {
    linkedUserIds: new Set(linkRows.map((row) => row.userId)),
    activeAccountUserIds: new Set(
      accountRows.filter((row) => row.status === "active").map((row) => row.userId),
    ),
  };
}

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
  const searchUsers =
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

  const recentUserIds = recents.map((entry) => entry.userId);
  const searchIds = searchUsers.map((u) => u.id);
  const flags = await externalFlags([...new Set([...recentUserIds, ...searchIds])]);

  return {
    recents: recents.map((entry) => ({
      userId: entry.userId,
      telegramUsername: entry.telegramUsername,
      firstName: entry.firstName,
      nickname: entry.nickname,
      lastUsedAt: entry.lastUsedAt,
      paysToExternal: flags.linkedUserIds.has(entry.userId) && !flags.activeAccountUserIds.has(entry.userId),
    })),
    search: searchUsers.map((u) => toRecipientView(u, flags.linkedUserIds, flags.activeAccountUserIds)),
  };
}
