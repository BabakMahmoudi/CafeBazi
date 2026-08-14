"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { retrieveRawInitData } from "@telegram-apps/sdk-react";
import { trpc } from "@/lib/trpc/client";
import { Link } from "@/i18n/navigation";
import { BalanceCard } from "./balance-card";
import { TransactionsList } from "./transactions-list";

type AuthState = "checking" | "guest" | "ready";

export function OnboardingGate() {
  const t = useTranslations();
  const wallet = trpc.wallet.get.useQuery(undefined, { retry: false });
  const [pendingFunding, setPendingFunding] = useState(false);

  const code = (wallet.error?.data as { code?: string } | undefined)?.code;
  const state: AuthState = wallet.isLoading
    ? "checking"
    : wallet.isSuccess
      ? "ready"
      : code === "UNAUTHORIZED"
        ? "guest"
        : "ready";

  async function startOnboarding() {
    let initData = "";
    try {
      initData = retrieveRawInitData() ?? "";
    } catch {
      return;
    }
    if (!initData) return;

    const res = await fetch("/api/auth/tma", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      accountStatus?: string;
    };
    if (res.ok && body.ok) {
      setPendingFunding(body.accountStatus === "pending_funding");
      wallet.refetch();
    }
  }

  if (state === "checking") {
    return <p className="opacity-60">{t("wallet.loading")}</p>;
  }

  if (state === "guest") {
    return (
      <div className="flex flex-col gap-4 rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold">{t("onboarding.title")}</h2>
        <p className="text-sm opacity-70">{t("onboarding.hint")}</p>
        {pendingFunding && (
          <p className="text-sm text-amber-700">{t("onboarding.pendingFunding")}</p>
        )}
        <button
          onClick={startOnboarding}
          className="rounded-xl bg-accent px-4 py-3 font-semibold text-white"
        >
          {t("onboarding.button")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BalanceCard />
      <nav className="flex gap-3">
        <Link
          href="/buy"
          className="flex-1 rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white"
        >
          {t("nav.buy")}
        </Link>
        <Link
          href="/send"
          className="flex-1 rounded-xl border border-accent px-4 py-3 text-center font-semibold text-accent"
        >
          {t("nav.send")}
        </Link>
      </nav>
      <TransactionsList />
    </div>
  );
}
