"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { requestAccess, signTransaction } from "@stellar/freighter-api";
import { trpc } from "@/lib/trpc/client";

type WalletError =
  | "notInstalled"
  | "rejected"
  | "challengeFailed"
  | "alreadyLinked"
  | "lastWallet"
  | "custodialKey"
  | "generic";

function typedCode(error: unknown): string | undefined {
  return (error as { data?: { typedCode?: string } } | null)?.data?.typedCode;
}

export function WalletsManager() {
  const t = useTranslations("wallets");
  const utils = trpc.useUtils();
  const wallets = trpc.wallets.list.useQuery();
  const linkStart = trpc.wallets.linkStart.useMutation();
  const linkVerify = trpc.wallets.linkVerify.useMutation();
  const unlink = trpc.wallets.unlink.useMutation();
  const logout = trpc.session.logout.useMutation();

  const [adding, setAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [error, setError] = useState<WalletError | null>(null);

  const items = wallets.data?.wallets ?? [];
  const takContractId = wallets.data?.takContractId ?? null;

  async function signOut() {
    setError(null);
    try {
      await logout.mutateAsync();
      await Promise.all([utils.wallet.get.invalidate(), utils.session.role.invalidate()]);
    } catch {
      setError("generic");
    }
  }

  async function addWallet() {
    setError(null);
    setAdding(true);
    try {
      if (typeof window === "undefined" || !(window as Window & { freighter?: boolean }).freighter) {
        setError("notInstalled");
        return;
      }

      const access = await requestAccess();
      if (access.error || !access.address) {
        setError("rejected");
        return;
      }

      const challenge = await linkStart.mutateAsync({ publicKey: access.address });
      const signed = await signTransaction(challenge.challengeXdr, {
        networkPassphrase: challenge.networkPassphrase,
      });
      if (signed.error || !signed.signedTxXdr) {
        setError("rejected");
        return;
      }

      await linkVerify.mutateAsync({ signedChallengeXdr: signed.signedTxXdr });
      await utils.wallets.list.invalidate();
    } catch (err) {
      const code = typedCode(err);
      if (code === "ALREADY_LINKED") {
        setError("alreadyLinked");
      } else if (code === "CUSTODIAL_KEY") {
        setError("custodialKey");
      } else if (code === "CHALLENGE_USED" || code === "CHALLENGE_EXPIRED") {
        setError("challengeFailed");
      } else {
        setError("generic");
      }
    } finally {
      setAdding(false);
    }
  }

  async function removeWallet(publicKey: string) {
    setError(null);
    setRemovingKey(publicKey);
    try {
      await unlink.mutateAsync({ publicKey });
      await utils.wallets.list.invalidate();
    } catch (err) {
      const code = typedCode(err);
      if (code === "LAST_WALLET") {
        setError("lastWallet");
      } else {
        setError("generic");
      }
    } finally {
      setRemovingKey(null);
    }
  }

  if (wallets.isPending) {
    return <p className="opacity-60">{t("loading")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {items.length === 0 ? (
        <p className="rounded-2xl bg-white p-4 text-sm shadow-sm">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((wallet) => (
            <li key={wallet.id} className="rounded-2xl bg-white p-4 shadow-sm">
              <p className="break-all font-mono text-xs leading-relaxed">{wallet.publicKey}</p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs opacity-60">
                  {t("verifiedAt")}: {new Date(wallet.verifiedAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => removeWallet(wallet.publicKey)}
                  disabled={removingKey === wallet.publicKey}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-40"
                >
                  {removingKey === wallet.publicKey ? t("removing") : t("remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {takContractId && (
        <div className="rounded-2xl bg-white p-4 text-sm shadow-sm">
          <p className="font-semibold">{t("contractTitle")}</p>
          <p className="mt-1 break-all font-mono text-xs opacity-70">{takContractId}</p>
          <p className="mt-2 text-xs opacity-60">{t("contractHint")}</p>
        </div>
      )}

      {error && <p className="rounded-xl bg-red-100 p-3 text-sm text-red-900">{t(error)}</p>}

      <button
        type="button"
        onClick={addWallet}
        disabled={adding}
        className="rounded-xl border border-accent px-4 py-3 font-semibold text-accent disabled:opacity-40"
      >
        {adding ? t("adding") : t("add")}
      </button>
      {error === "notInstalled" && (
        <a
          href="https://freighter.app"
          target="_blank"
          rel="noreferrer"
          className="text-center text-sm font-medium text-accent underline"
        >
          {t("installLink")}
        </a>
      )}

      <button
        type="button"
        onClick={signOut}
        disabled={logout.isPending}
        className="rounded-xl border border-zinc-200 px-4 py-3 font-semibold opacity-70 disabled:opacity-40"
      >
        {logout.isPending ? t("signingOut") : t("logout")}
      </button>
    </div>
  );
}
