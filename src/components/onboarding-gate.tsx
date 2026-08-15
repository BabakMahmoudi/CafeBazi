"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { retrieveRawInitData } from "@telegram-apps/sdk-react";
import { trpc } from "@/lib/trpc/client";
import { Link } from "@/i18n/navigation";
import { telegramMockState } from "./telegram-provider";
import { BalanceCard } from "./balance-card";
import { TransactionsList } from "./transactions-list";

type AuthState = "checking" | "guest" | "ready";

export function OnboardingGate() {
  const t = useTranslations();
  const wallet = trpc.wallet.get.useQuery(undefined, { retry: false });
  const [pendingFunding, setPendingFunding] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const code = (wallet.error?.data as { code?: string } | undefined)?.code;
  const state: AuthState = wallet.isLoading
    ? "checking"
    : wallet.isSuccess
      ? "ready"
      : code === "UNAUTHORIZED"
        ? "guest"
        : "ready";

  async function startOnboarding() {
    setAuthError(null);
    setSubmitting(true);
    try {
      let initData: string | undefined;
      try {
        initData = retrieveRawInitData();
      } catch {
        initData = undefined;
      }
      if (!initData || telegramMockState.mocked) {
        setAuthError(t("onboarding.openInTelegram"));
        return;
      }

      let res: Response;
      try {
        res = await fetch("/api/auth/tma", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initData }),
        });
      } catch {
        setAuthError(t("onboarding.authFailed"));
        return;
      }

      let body: { ok?: boolean; accountStatus?: string } | null = null;
      try {
        body = (await res.json()) as { ok?: boolean; accountStatus?: string };
      } catch {
        body = null;
      }

      if (!res.ok || !body?.ok) {
        setAuthError(t("onboarding.authFailed"));
        return;
      }

      setPendingFunding(body.accountStatus === "pending_funding");
      await wallet.refetch();
    } finally {
      setSubmitting(false);
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
        {authError && (
          <p className="rounded-xl bg-red-100 p-3 text-sm text-red-900">{authError}</p>
        )}
        <button
          type="button"
          onClick={startOnboarding}
          disabled={submitting}
          className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
        >
          {submitting ? t("onboarding.loading") : t("onboarding.button")}
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
