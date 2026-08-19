import { getTranslations } from "next-intl/server";
import { EspressoRoulette } from "@/components/espresso-roulette";

export default async function GamePage() {
  const t = await getTranslations("game");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <EspressoRoulette />
    </main>
  );
}
