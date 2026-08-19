import { getTranslations } from "next-intl/server";
import { WalletsManager } from "@/components/wallets-manager";

export default async function WalletsPage() {
  const t = await getTranslations("wallets");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <WalletsManager />
    </main>
  );
}
