"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

export function BalanceCard() {
  const t = useTranslations();
  const wallet = trpc.wallet.get.useQuery();
  const balance = wallet.data?.balance ?? 0n;
  const accountId = wallet.data?.stellarAccountId ?? null;
  const [copied, setCopied] = useState(false);

  async function copyAccountId() {
    if (!accountId || copied) return;
    try {
      await navigator.clipboard.writeText(accountId);
    } catch {
      const input = document.createElement("textarea");
      input.value = accountId;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-2xl bg-accent p-5 text-white shadow-sm">
      <p className="text-sm opacity-80">{t("wallet.balance")}</p>
      <p className="mt-1 text-3xl font-bold">
        {balance.toString()} {t("wallet.tak")}
      </p>
      {accountId && (
        <div className="mt-4 border-t border-white/20 pt-3">
          <p className="text-xs opacity-80">{t("wallet.accountId")}</p>
          <button
            type="button"
            onClick={copyAccountId}
            className="mt-2 w-full rounded-xl bg-white/10 px-3 py-2 text-left transition-colors hover:bg-white/20"
          >
            <span className="block text-xs font-mono break-all leading-relaxed">{accountId}</span>
            <span className="mt-1 block text-xs font-medium">
              {copied ? t("wallet.copied") : t("wallet.copy")}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
