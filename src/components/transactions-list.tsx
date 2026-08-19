"use client";

import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

const TYPE_KEYS: Record<string, string> = {
  purchase: "wallet.purchase",
  p2p: "wallet.p2p",
  gift: "wallet.gift",
  mint: "wallet.mint",
  burn: "wallet.burn",
  redemption: "wallet.redemption",
  withdrawal: "wallet.withdrawal",
  lottery: "wallet.lottery",
};

const STATUS_KEYS: Record<string, string> = {
  pending: "wallet.pending",
  submitted: "wallet.submitted",
  confirmed: "wallet.confirmed",
  failed: "wallet.failed",
};

export function TransactionsList() {
  const t = useTranslations();
  const wallet = trpc.wallet.get.useQuery();

  const transactions = wallet.data?.transactions ?? [];

  if (wallet.isPending) {
    return <p className="opacity-60">{t("wallet.loading")}</p>;
  }

  if (transactions.length === 0) {
    return <p className="opacity-60">{t("wallet.empty")}</p>;
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold opacity-70">{t("wallet.transactions")}</h2>
      <ul className="flex flex-col gap-2">
        {transactions.map((tx) => (
          <li key={tx.id} className="rounded-xl bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{t(TYPE_KEYS[tx.type] ?? "wallet.gift")}</span>
              <span className="font-semibold">
                {tx.amount.toString()} {t("wallet.tak")}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-sm opacity-60">
              <span>{t(STATUS_KEYS[tx.status] ?? tx.status)}</span>
              <span>{new Date(tx.createdAt).toLocaleDateString()}</span>
            </div>
            {tx.memo && <p className="mt-1 text-sm opacity-70">{tx.memo}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
