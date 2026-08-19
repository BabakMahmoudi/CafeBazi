"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { requestAccess, signTransaction } from "@stellar/freighter-api";
import { trpc } from "@/lib/trpc/client";

type WebLoginProps = {
  onSuccess?: () => void;
};

type LoginError =
  | "notInstalled"
  | "rejected"
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

export function WebLogin({ onSuccess }: WebLoginProps) {
  const t = useTranslations("webLogin");
  const utils = trpc.useUtils();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);

  async function signIn() {
    setError(null);
    setSubmitting(true);
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

      let challengeRes: Response;
      try {
        challengeRes = await fetch("/api/auth/stellar/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicKey: access.address, purpose: "login" }),
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

      if (!challengeRes.ok || !challengeBody?.ok || !challengeBody.challengeXdr) {
        setError(challengeBody?.error === "rate_limit" ? "rateLimited" : "challengeFailed");
        return;
      }

      const signed = await signTransaction(challengeBody.challengeXdr, {
        networkPassphrase: challengeBody.networkPassphrase,
      });
      if (signed.error || !signed.signedTxXdr) {
        setError("rejected");
        return;
      }

      let verifyRes: Response;
      try {
        verifyRes = await fetch("/api/auth/stellar/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signedChallengeXdr: signed.signedTxXdr, purpose: "login" }),
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

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={signIn}
        disabled={submitting}
        className="rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
      >
        {submitting ? t("loading") : t("button")}
      </button>
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
