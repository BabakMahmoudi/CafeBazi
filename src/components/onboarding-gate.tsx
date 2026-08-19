"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { retrieveRawInitData } from "@telegram-apps/sdk-react";
import { trpc } from "@/lib/trpc/client";
import { Link } from "@/i18n/navigation";
import { telegramMockState } from "./telegram-provider";
import { WebLogin } from "./web-login";
import { BalanceCard } from "./balance-card";
import { TransactionsList } from "./transactions-list";

type AuthState = "checking" | "guest" | "ready";

function readInitData(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    const webAppInitData = (
      window as Window & { Telegram?: { WebApp?: { initData?: string } } }
    ).Telegram?.WebApp?.initData;
    return webAppInitData || retrieveRawInitData();
  } catch {
    return undefined;
  }
}

export function OnboardingGate() {
  const t = useTranslations();
  const wallet = trpc.wallet.get.useQuery(undefined, { retry: false });
  const role = trpc.session.role.useQuery(undefined, { retry: false });
  const [pendingFunding, setPendingFunding] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [initData] = useState(readInitData);

  const code = (wallet.error?.data as { code?: string } | undefined)?.code;
  const state: AuthState = wallet.isLoading
    ? "checking"
    : wallet.isSuccess
      ? "ready"
      : code === "UNAUTHORIZED"
        ? "guest"
        : "ready";

  const insideTelegram = Boolean(initData) && !telegramMockState.mocked;

  async function startOnboarding() {
    setAuthError(null);
    setSubmitting(true);
    try {
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
        <p className="text-sm opacity-70">
          {insideTelegram ? t("onboarding.hint") : t("webLogin.hint")}
        </p>
        {pendingFunding && (
          <p className="text-sm text-amber-700">{t("onboarding.pendingFunding")}</p>
        )}
        {insideTelegram ? (
          <>
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
          </>
        ) : (
          <WebLogin
            onSuccess={() => {
              void wallet.refetch();
              void role.refetch();
            }}
          />
        )}
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
        <Link
          href="/wallets"
          className="flex-1 rounded-xl border border-accent px-4 py-3 text-center font-semibold text-accent"
        >
          {t("nav.wallet")}
        </Link>
      </nav>
      {role.data === "admin" && (
        <Link
          href="/admin"
          className="rounded-xl border border-accent px-4 py-3 text-center font-semibold text-accent"
        >
          {t("nav.admin")}
        </Link>
      )}
      <TransactionsList />
    </div>
  );
}
