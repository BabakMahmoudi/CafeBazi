"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { trpc } from "@/lib/trpc/client";

type PasswordAuthProps = {
  onSuccess?: () => void;
};

type Mode = "signin" | "signup" | "code";

type AuthResponse = {
  ok?: boolean;
  error?: string;
  accountStatus?: string;
  codeLoginAvailable?: boolean;
};

const ERROR_KEYS: Record<string, string> = {
  invalid_credentials: "invalidCredentials",
  account_locked: "accountLocked",
  username_taken: "usernameTaken",
  invalid_username: "usernameInvalid",
  weak_password: "passwordWeak",
  account_not_found: "accountNotFound",
  invalid_code: "invalidCode",
  code_expired: "codeExpired",
  too_many_attempts: "codeAttempts",
  rate_limited: "rateLimited",
  resend_cooldown: "resendCooldown",
  bot_not_started: "botNotStarted",
  send_failed: "sendFailed",
};

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";
const RESEND_SECONDS = 60;

export function PasswordAuth({ onSuccess }: PasswordAuthProps) {
  const t = useTranslations("passwordAuth");
  const tRoot = useTranslations();
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<Mode>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [botNotStarted, setBotNotStarted] = useState(false);
  const [collision, setCollision] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingFunding, setPendingFunding] = useState(false);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => setResendCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirmPassword("");
    setCode("");
    setCodeSent(false);
    setBotNotStarted(false);
    setCollision(false);
    setResendCooldown(0);
  }

  async function finishLogin(accountStatus?: string) {
    setPendingFunding(accountStatus === "pending_funding");
    await Promise.all([
      utils.wallet.get.invalidate(),
      utils.session.role.invalidate(),
    ]);
    onSuccess?.();
  }

  async function requestCode() {
    setError(null);
    setBotNotStarted(false);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/telegram-code/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      let body: AuthResponse | null = null;
      try {
        body = (await res.json()) as AuthResponse;
      } catch {
        body = null;
      }

      if (!res.ok || !body?.ok) {
        if (body?.error === "bot_not_started") {
          setBotNotStarted(true);
          return;
        }
        setError(ERROR_KEYS[body?.error ?? ""] ?? "generic");
        return;
      }

      setCode("");
      setCodeSent(true);
      setResendCooldown(RESEND_SECONDS);
    } catch {
      setError("generic");
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/telegram-code/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, code }),
      });

      let body: AuthResponse | null = null;
      try {
        body = (await res.json()) as AuthResponse;
      } catch {
        body = null;
      }

      if (!res.ok || !body?.ok) {
        setError(ERROR_KEYS[body?.error ?? ""] ?? "generic");
        return;
      }

      await finishLogin(body.accountStatus);
    } catch {
      setError("generic");
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (mode === "code") {
      if (codeSent) {
        await verifyCode();
      } else {
        await requestCode();
      }
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      setError("confirmMismatch");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/auth/password/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      let body: AuthResponse | null = null;
      try {
        body = (await res.json()) as AuthResponse;
      } catch {
        body = null;
      }

      if (!res.ok || !body?.ok) {
        if (mode === "signup" && body?.codeLoginAvailable) {
          setCollision(true);
        }
        setError(ERROR_KEYS[body?.error ?? ""] ?? "generic");
        return;
      }

      await finishLogin(body.accountStatus);
    } catch {
      setError("generic");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex rounded-xl bg-black/5 p-1">
        <button
          type="button"
          onClick={() => switchMode("signin")}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
            mode === "signin" ? "bg-white text-foreground shadow-sm" : "text-foreground/60"
          }`}
        >
          {t("signin")}
        </button>
        <button
          type="button"
          onClick={() => switchMode("signup")}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
            mode === "signup" ? "bg-white text-foreground shadow-sm" : "text-foreground/60"
          }`}
        >
          {t("signup")}
        </button>
        <button
          type="button"
          onClick={() => switchMode("code")}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold ${
            mode === "code" ? "bg-white text-foreground shadow-sm" : "text-foreground/60"
          }`}
        >
          {tRoot("telegramCode.title")}
        </button>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-2">
        {mode === "code" ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="opacity-70">{tRoot("telegramCode.username")}</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                maxLength={32}
                className="rounded-xl border border-black/10 px-3 py-2 outline-none focus:border-accent"
              />
            </label>

            {botNotStarted ? (
              <div className="flex flex-col gap-2 rounded-xl bg-amber-100 p-3 text-sm text-amber-900">
                <p>{tRoot("telegramCode.botNotStarted")}</p>
                <a
                  href={`https://t.me/${BOT_USERNAME}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold underline"
                >
                  {tRoot("telegramCode.openBot")}
                </a>
              </div>
            ) : codeSent ? (
              <>
                <p className="text-sm opacity-70">{tRoot("telegramCode.codeSent")}</p>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="opacity-70">{tRoot("telegramCode.codeLabel")}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="rounded-xl border border-black/10 px-3 py-2 text-center text-2xl tracking-widest outline-none focus:border-accent"
                  />
                </label>
              </>
            ) : (
              <p className="text-sm opacity-60">{tRoot("telegramCode.subtitle")}</p>
            )}

            {error && (
              <p className="rounded-xl bg-red-100 p-3 text-sm text-red-900">
                {tRoot(`telegramCode.${error}`)}
              </p>
            )}

            {collision && (
              <div className="flex flex-col gap-2 rounded-xl bg-blue-100 p-3 text-sm">
                <p>{tRoot("telegramCode.signupCollision")}</p>
                <button
                  type="button"
                  onClick={() => switchMode("code")}
                  className="self-start rounded-lg bg-accent px-3 py-2 font-semibold text-white"
                >
                  {tRoot("telegramCode.switchToCode")}
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-1 rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
            >
              {submitting
                ? codeSent
                  ? tRoot("telegramCode.verifying")
                  : tRoot("telegramCode.sendingCode")
                : botNotStarted
                  ? tRoot("telegramCode.resend")
                  : codeSent
                    ? tRoot("telegramCode.verify")
                    : tRoot("telegramCode.sendCode")}
            </button>

            {codeSent && !botNotStarted && (
              <button
                type="button"
                disabled={resendCooldown > 0 || submitting}
                onClick={() => void requestCode()}
                className="text-sm text-foreground/60 disabled:opacity-40"
              >
                {resendCooldown > 0
                  ? tRoot("telegramCode.resendIn", { n: resendCooldown })
                  : tRoot("telegramCode.resend")}
              </button>
            )}
          </>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="opacity-70">{t("username")}</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                maxLength={32}
                className="rounded-xl border border-black/10 px-3 py-2 outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="opacity-70">{t("password")}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                className="rounded-xl border border-black/10 px-3 py-2 outline-none focus:border-accent"
              />
            </label>
            {mode === "signup" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">{t("confirmPassword")}</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  className="rounded-xl border border-black/10 px-3 py-2 outline-none focus:border-accent"
                />
              </label>
            )}

            {error && (
              <p className="rounded-xl bg-red-100 p-3 text-sm text-red-900">{t(error)}</p>
            )}

            {collision && (
              <div className="flex flex-col gap-2 rounded-xl bg-blue-100 p-3 text-sm">
                <p>{tRoot("telegramCode.signupCollision")}</p>
                <button
                  type="button"
                  onClick={() => switchMode("code")}
                  className="self-start rounded-lg bg-accent px-3 py-2 font-semibold text-white"
                >
                  {tRoot("telegramCode.switchToCode")}
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-1 rounded-xl bg-accent px-4 py-3 font-semibold text-white disabled:opacity-40"
            >
              {submitting
                ? mode === "signin"
                  ? t("signingIn")
                  : t("signingUp")
                : mode === "signin"
                  ? t("signin")
                  : t("signup")}
            </button>
          </>
        )}

        {pendingFunding && (
          <p className="text-sm text-amber-700">{tRoot("onboarding.pendingFunding")}</p>
        )}
      </form>
    </div>
  );
}
