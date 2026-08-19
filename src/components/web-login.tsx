"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";
import {
  getWalletProviders,
  UnsupportedNetworkError,
  type StellarWalletProvider,
} from "@/lib/wallet-providers";

type WebLoginProps = {
  onSuccess?: () => void;
};

type LoginError =
  | "notInstalled"
  | "rejected"
  | "notSupported"
  | "challengeFailed"
  | "verifyFailed"
  | "rateLimited"
  | "generic";

type ChallengeResponse = {
  ok?: boolean;
  error?: string;
  challengeXdr?: string;
  networkPassphrase?: string;
};

type VerifyResponse = {
  ok?: boolean;
  error?: string;
};

const BUTTON_LABELS: Record<StellarWalletProvider["id"], string> = {
  freighter: "providers.freighter",
  albedo: "providers.albedo",
};

export function WebLogin({ onSuccess }: WebLoginProps) {
  const t = useTranslations("webLogin");
  const utils = trpc.useUtils();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  async function signInWith(provider: StellarWalletProvider) {
    setError(null);
    setSubmitting(true);
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

      let challengeRes: Response;
      try {
        challengeRes = await fetch("/api/auth/stellar/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey: address, purpose: "login" }),
        });
      } catch {
        setError("challengeFailed");
        return;
      }

      let challengeBody: ChallengeResponse | null = null;
      try {
        challengeBody = (await challengeRes.json()) as ChallengeResponse;
      } catch {
        challengeBody = null;
      }

      if (
        !challengeRes.ok ||
        !challengeBody?.ok ||
        !challengeBody.challengeXdr ||
        !challengeBody.networkPassphrase
      ) {
        setError(challengeBody?.error === "rate_limit" ? "rateLimited" : "challengeFailed");
        return;
      }

      let signedXdr: string;
      try {
        signedXdr = await provider.signChallenge(
          challengeBody.challengeXdr,
          challengeBody.networkPassphrase,
        );
      } catch (err) {
        setError(err instanceof UnsupportedNetworkError ? "notSupported" : "rejected");
        return;
      }

      let verifyRes: Response;
      try {
        verifyRes = await fetch("/api/auth/stellar/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signedChallengeXdr: signedXdr, purpose: "login" }),
        });
      } catch {
        setError("verifyFailed");
        return;
      }

      let verifyBody: VerifyResponse | null = null;
      try {
        verifyBody = (await verifyRes.json()) as VerifyResponse;
      } catch {
        verifyBody = null;
      }

      if (!verifyRes.ok || !verifyBody?.ok) {
        setError(verifyBody?.error === "challenge_expired" ? "challengeFailed" : "verifyFailed");
        return;
      }

      await Promise.all([
        utils.wallet.get.invalidate(),
        utils.session.role.invalidate(),
      ]);
      onSuccess?.();
    } catch {
      setError("generic");
    } finally {
      setSubmitting(false);
    }
  }

  const providers = getWalletProviders();
  if (providers.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          onClick={() => signInWith(provider)}
          disabled={submitting}
          className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
        >
          {submitting ? t("loading") : t(BUTTON_LABELS[provider.id])}
        </button>
      ))}
      {error && (
        <p className="rounded-xl bg-red-100 p-3 text-sm text-red-900">{t(error)}</p>
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
    </div>
  );
}
