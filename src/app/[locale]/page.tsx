import { getTranslations } from "next-intl/server";
import { OnboardingGate } from "@/components/onboarding-gate";

export default async function HomePage() {
  const t = await getTranslations("app");

  return (
    <main
      data-testid="app-shell"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 p-4"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-sm opacity-70">{t("tagline")}</p>
      </header>
      <OnboardingGate />
    </main>
  );
}
