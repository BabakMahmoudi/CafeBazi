"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import { ExternalSend } from "./external-send";

type SendError = "recipientNotActive" | "accountNotReady" | "generic";

function sendErrorKey(error: unknown): SendError {
  const typedCode = (error as { data?: { typedCode?: string } } | null)?.data?.typedCode;
  if (typedCode === "RECIPIENT_NOT_ACTIVE") return "recipientNotActive";
  if (typedCode === "ACCOUNT_NOT_READY") return "accountNotReady";
  return "generic";
}

export function SendCup() {
  const t = useTranslations("send");
  const recipients = trpc.payments.recipients.useQuery({ query: "" });
  const send = trpc.payments.send.useMutation();

  const [tab, setTab] = useState<"user" | "external">("user");
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [cups, setCups] = useState(1);
  const [memo, setMemo] = useState("");
  const [sendError, setSendError] = useState<SendError | null>(null);

  const searchResults = trpc.payments.recipients.useQuery({ query: search || undefined });

  const recents = recipients.data?.recents ?? [];
  const results = searchResults.data?.search ?? [];

  async function handleSend() {
    if (!selectedUserId) return;
    setSendError(null);
    try {
      await send.mutateAsync({
        recipientId: selectedUserId,
        amount: BigInt(cups),
        memo: memo || undefined,
      });
    } catch (err) {
      setSendError(sendErrorKey(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 rounded-xl bg-zinc-100 p-1">
        <button
          onClick={() => setTab("user")}
          className={`flex-1 rounded-lg py-2 text-sm font-semibold ${
            tab === "user" ? "bg-white shadow-sm" : "opacity-60"
          }`}
        >
          {t("tabToUser")}
        </button>
        <button
          onClick={() => setTab("external")}
          className={`flex-1 rounded-lg py-2 text-sm font-semibold ${
            tab === "external" ? "bg-white shadow-sm" : "opacity-60"
          }`}
        >
          {t("tabExternal")}
        </button>
      </div>

      {tab === "external" ? (
        <ExternalSend />
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold opacity-70">{t("recents")}</h2>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("search")}
              className="rounded-xl border border-zinc-200 bg-white p-3"
            />
            {(search ? results : recents).length === 0 ? (
              <p className="text-sm opacity-60">{t("noResults")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {(search ? results : recents).map((user) => (
                  <button
                    key={user.userId}
                    onClick={() => setSelectedUserId(user.userId)}
                    className={`rounded-xl border p-3 text-start ${
                      selectedUserId === user.userId
                        ? "border-accent bg-white"
                        : "border-zinc-200 bg-white/60"
                    }`}
                  >
                    <span className="font-semibold">{user.firstName}</span>
                    {user.telegramUsername && (
                      <span className="block text-sm opacity-60">@{user.telegramUsername}</span>
                    )}
                    {user.paysToExternal && (
                      <span className="block text-xs text-accent">{t("paysToExternalHint")}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
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
            <p className="rounded-xl bg-green-100 p-3 text-green-900">{t("success")}</p>
          )}
          {sendError && (
            <p className="rounded-xl bg-red-100 p-3 text-red-900">
              {t(sendError === "generic" ? "error" : sendError)}
            </p>
          )}

          <button
            onClick={handleSend}
            disabled={!selectedUserId}
            className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
          >
            {t("confirm")} · {cups} ☕
          </button>
        </>
      )}
    </div>
  );
}
