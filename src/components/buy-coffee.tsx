"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { retrieveLaunchParams } from "@telegram-apps/sdk-react";
import { parseStartParam } from "@/lib/qr";
import { trpc } from "@/lib/trpc/client";

function readStartParam(): { slug: string; table: string } | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const launchParams = retrieveLaunchParams();
    const parsed = parseStartParam(launchParams.tgWebAppStartParam);
    return parsed ? { slug: parsed.shopId, table: parsed.table ?? "" } : null;
  } catch {
    return null;
  }
}

export function BuyCoffee() {
  const t = useTranslations("buy");
  const shops = trpc.shops.listActive.useQuery();
  const create = trpc.payments.create.useMutation();

  const [selectedSlug, setSelectedSlug] = useState("");
  const [cups, setCups] = useState(1);
  const [table, setTable] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      const startParam = readStartParam();
      if (startParam && !cancelled) {
        setSelectedSlug(startParam.slug);
        setTable(startParam.table);
        setPrefilled(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const shopList = shops.data ?? [];

  async function handlePay() {
    if (!selectedSlug) return;
    setPayError(null);
    try {
      await create.mutateAsync({
        shopSlug: selectedSlug,
        cups,
        table: table || undefined,
      });
    } catch (err) {
      const typedCode = (err as { data?: { typedCode?: string } } | null)?.data?.typedCode;
      setPayError(typedCode === "ACCOUNT_NOT_READY" ? "accountNotReady" : "generic");
    }
  }

  const creating = create.isPending;
  const done = create.isSuccess;

  return (
    <div className="flex flex-col gap-4">
      {prefilled && selectedSlug && (
        <p className="rounded-xl bg-white p-3 text-sm shadow-sm">
          {t("confirm")} — {shopList.find((s) => s.slug === selectedSlug)?.name ?? selectedSlug}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold opacity-70">{t("selectShop")}</h2>
        <div className="flex flex-col gap-2">
          {shopList.map((shop) => (
            <button
              key={shop.id}
              onClick={() => setSelectedSlug(shop.slug)}
              className={`rounded-xl border p-3 text-start ${
                selectedSlug === shop.slug ? "border-accent bg-white" : "border-zinc-200 bg-white/60"
              }`}
            >
              <span className="font-semibold">{shop.name}</span>
              {shop.address && <span className="block text-sm opacity-60">{shop.address}</span>}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold opacity-70">{t("cups")}</h2>
        <div className="flex gap-2">
          {[1, 2, 3, 5].map((count) => (
            <button
              key={count}
              onClick={() => setCups(count)}
              className={`flex-1 rounded-xl border py-3 text-lg font-bold ${
                cups === count ? "border-accent bg-accent text-white" : "border-zinc-200 bg-white"
              }`}
            >
              {count}
            </button>
          ))}
        </div>
      </section>

      {table && (
        <p className="text-sm opacity-60">
          {t("selectShop")}: {table}
        </p>
      )}

      {done && <p className="rounded-xl bg-green-100 p-3 text-green-900">{t("confirmed")}</p>}
      {payError && (
        <p className="rounded-xl bg-red-100 p-3 text-red-900">
          {t(payError === "generic" ? "error" : payError)}
        </p>
      )}

      {creating ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-white p-6 shadow-sm">
          <span className="brewing text-5xl">☕</span>
          <p>{t("brewing")}</p>
        </div>
      ) : (
        <button
          onClick={handlePay}
          disabled={!selectedSlug || shops.isLoading}
          className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
        >
          {t("confirm")} · {cups} {cups === 1 ? t("cup") : t("cupsUnit")}
        </button>
      )}
    </div>
  );
}
