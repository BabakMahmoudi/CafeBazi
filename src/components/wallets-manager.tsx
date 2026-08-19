"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { openLink } from "@telegram-apps/sdk-react";
import { trpc } from "@/lib/trpc/client";
import {
  getWalletProviders,
  isBrowserContext,
  UnsupportedNetworkError,
  type StellarWalletProvider,
} from "@/lib/wallet-providers";

type WalletError =
  | "notInstalled"
  | "rejected"
  | "notSupported"
  | "challengeFailed"
  | "alreadyLinked"
  | "lastWallet"
  | "custodialKey"
  | "generic";

const ADD_LABELS: Record<StellarWalletProvider["id"], string> = {
  freighter: "addFreighter",
  albedo: "addAlbedo",
};

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

  const [addingProvider, setAddingProvider] = useState<string | null>(null);
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

  async function linkWalletWith(provider: StellarWalletProvider) {
    setError(null);
    setAddingProvider(provider.id);
    try {
      if (
        provider.id === "freighter" &&
        (typeof window === "undefined" || !(window as Window & { freighter?: boolean }).freighter)
      ) {
        setError("notInstalled");
        return;
      }

      let address: string;
      try {
        address = await provider.getPublicKey();
      } catch {
        setError("rejected");
        return;
      }

      const challenge = await linkStart.mutateAsync({ publicKey: address });

      let signedXdr: string;
      try {
        signedXdr = await provider.signChallenge(
          challenge.challengeXdr,
          challenge.networkPassphrase,
        );
      } catch (err) {
        setError(err instanceof UnsupportedNetworkError ? "notSupported" : "rejected");
        return;
      }

      await linkVerify.mutateAsync({ signedChallengeXdr: signedXdr });
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
      setAddingProvider(null);
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

  const browserContext = isBrowserContext();
  const providers = browserContext ? getWalletProviders() : [];

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

      {browserContext ? (
        providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => linkWalletWith(provider)}
            disabled={addingProvider !== null}
            className="rounded-xl border border-accent px-4 py-3 font-semibold text-accent disabled:opacity-40"
          >
            {addingProvider === provider.id ? t("adding") : t(ADD_LABELS[provider.id])}
          </button>
        ))
      ) : (
        <div className="rounded-2xl bg-amber-50 p-4 text-sm shadow-sm">
          <p>{t("phoneHint")}</p>
          <button
            type="button"
            onClick={() => openLink(window.location.href)}
            className="mt-3 rounded-xl bg-accent px-4 py-2.5 font-semibold text-white"
          >
            {t("openInBrowser")}
          </button>
        </div>
      )}
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
