import { getTranslations } from "next-intl/server";
import { SendCup } from "@/components/send-cup";

export default async function SendPage() {
  const t = await getTranslations("send");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <SendCup />
    </main>
  );
}
