import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { QrCard } from "@/components/qr-card";
import { buildStartAppUrl } from "@/lib/qr";
import { getActiveShopBySlug } from "@/services/shops";

export default async function QrPage({
  params,
  searchParams,
}: {
  params: Promise<{ shopSlug: string }>;
  searchParams: Promise<{ table?: string }>;
}) {
  const [{ shopSlug }, { table }] = await Promise.all([params, searchParams]);
  const shop = await getActiveShopBySlug(shopSlug);
  if (!shop) {
    notFound();
  }

  const t = await getTranslations("qr");
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";
  const url = buildStartAppUrl(botUsername, {
    shopId: shop.slug,
    table: table || undefined,
  });

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <QrCard
        value={url}
        title={shop.name}
        subtitle={table ? `${t("table")} ${table}` : undefined}
      />
      <p className="text-sm opacity-60">{t("scanHint")}</p>
    </main>
  );
}
