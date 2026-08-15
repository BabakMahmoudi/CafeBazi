"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

export function BalanceCard() {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const [copied, setCopied] = useState(false);
  const [synced, setSynced] = useState(false);
  const wallet = trpc.wallet.get.useQuery();
  const sync = trpc.wallet.sync.useMutation({
    onSuccess: (data) => {
      if (data.synced) {
        utils.wallet.get.setData(undefined, (prev) =>
          prev ? { ...prev, balance: data.balance } : prev,
        );
        utils.wallet.get.invalidate();
      }
      setSynced(true);
      setTimeout(() => setSynced(false), 2000);
    },
  });
  const balance = wallet.data?.balance ?? 0n;
  const accountId = wallet.data?.stellarAccountId ?? null;

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
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm opacity-80">{t("wallet.balance")}</p>
        <button
          type="button"
          onClick={() => sync.mutate()}
          disabled={sync.isPending || !accountId}
          className="rounded-lg bg-white/10 px-2 py-1 text-xs font-medium transition-colors hover:bg-white/20 disabled:opacity-50"
        >
          {sync.isPending ? t("wallet.syncing") : synced ? t("wallet.synced") : t("wallet.sync")}
        </button>
      </div>
      <p className="mt-1 text-3xl font-bold">
        {balance.toString()} {t("wallet.tak")}
      </p>
      {sync.isError && <p className="mt-2 text-xs text-red-200">{t("wallet.syncFailed")}</p>}
      {sync.data && !sync.data.synced && !sync.isPending && (
        <p className="mt-2 text-xs text-red-200">{t("wallet.syncNotReady")}</p>
      )}
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
