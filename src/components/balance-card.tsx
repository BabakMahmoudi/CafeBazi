"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

export function BalanceCard() {
  const t = useTranslations();
  const wallet = trpc.wallet.get.useQuery();
  const balance = wallet.data?.balance ?? 0n;

  return (
    <div className="rounded-2xl bg-accent p-5 text-white shadow-sm">
      <p className="text-sm opacity-80">{t("wallet.balance")}</p>
      <p className="mt-1 text-3xl font-bold">
        {balance.toString()} {t("wallet.tak")}
      </p>
    </div>
  );
}
