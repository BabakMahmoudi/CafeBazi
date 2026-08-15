import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSessionToken, verifySessionToken } from "@/lib/auth";
import { redirect } from "@/i18n/navigation";
import { AdminUsersTable } from "@/components/admin/users-table";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("admin");

  const token = await getSessionToken();
  let isAdmin = false;
  if (token) {
    try {
      const payload = await verifySessionToken(token);
      const rows = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
      isAdmin = rows[0]?.role === "admin";
    } catch {
      isAdmin = false;
    }
  }

  if (!isAdmin) {
    redirect({ href: "/", locale });
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="text-sm opacity-70">{t("description")}</p>
      <AdminUsersTable />
    </main>
  );
}
