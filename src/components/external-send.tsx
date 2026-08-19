"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

const ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export function ExternalSend() {
  const t = useTranslations("send");
  const send = trpc.payments.sendExternal.useMutation();
  const wallets = trpc.wallets.list.useQuery();

  const [address, setAddress] = useState("");
  const [cups, setCups] = useState(1);
  const [memo, setMemo] = useState("");

  const linkedWallet = wallets.data?.wallets[0]?.publicKey;
  const effectiveAddress = address.trim() || linkedWallet || "";
  const addressValid = ADDRESS_REGEX.test(effectiveAddress);

  async function handleSend() {
    if (!addressValid || cups < 1) return;
    await send.mutateAsync({
      address: effectiveAddress,
      amount: BigInt(cups),
      memo: memo || undefined,
    });
    setAddress("");
    setCups(1);
    setMemo("");
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold opacity-70">{t("externalTitle")}</h2>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold opacity-70">{t("externalAddress")}</h2>
        <input
          value={effectiveAddress}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t("externalPlaceholder")}
          dir="ltr"
          className="rounded-xl border border-zinc-200 bg-white p-3 text-start"
        />
        {effectiveAddress && !addressValid && (
          <p className="text-sm text-red-600">{t("externalInvalid")}</p>
        )}
        <p className="text-sm opacity-60">{t("externalHint")}</p>
        {linkedWallet && <p className="text-sm opacity-60">{t("externalLinkedHint")}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold opacity-70">{t("amount")}</h2>
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

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold opacity-70">{t("memo")}</h2>
        <input
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder={t("memoPlaceholder")}
          className="rounded-xl border border-zinc-200 bg-white p-3"
        />
      </section>

      {send.isSuccess && (
        <p className="rounded-xl bg-green-100 p-3 text-green-900">{t("externalSuccess")}</p>
      )}
      {send.isError && <p className="rounded-xl bg-red-100 p-3 text-red-900">{t("error")}</p>}

      <button
        onClick={handleSend}
        disabled={!addressValid || cups < 1}
        className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
      >
        {t("confirm")} · {cups} ☕
      </button>
    </div>
  );
}
