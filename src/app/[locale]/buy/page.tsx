import { getTranslations } from "next-intl/server";
import { BuyCoffee } from "@/components/buy-coffee";

export default async function BuyPage() {
  const t = await getTranslations("buy");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <BuyCoffee />
    </main>
  );
}
