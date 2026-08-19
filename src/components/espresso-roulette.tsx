"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  hapticFeedbackImpactOccurred,
  hapticFeedbackNotificationOccurred,
  isHapticFeedbackSupported,
} from "@telegram-apps/sdk-react";
import { trpc } from "@/lib/trpc/client";
import { RouletteWheel, type RouletteSlot } from "./roulette-wheel";

const WHEEL_SLOTS: RouletteSlot[] = [
  { emoji: "🥀", labelKey: "burnt" },
  { emoji: "☕", labelKey: "cup" },
  { emoji: "🎁", labelKey: "double" },
  { emoji: "🥀", labelKey: "burnt" },
  { emoji: "👑", labelKey: "jackpot" },
  { emoji: "🥀", labelKey: "burnt" },
  { emoji: "☕", labelKey: "cup" },
  { emoji: "🎁", labelKey: "double" },
];

const CONFETTI_COLORS = ["#7c4a21", "#b9895a", "#d4af37", "#e5484d", "#8a7b6d"];

type Phase = "loading" | "idle" | "spinning" | "result";

type SessionData = {
  sessionId: string;
  nonce: string;
  hmac: string;
  expiresAt: Date;
  freeSpinsRemaining: number;
  paidSpinCost: bigint;
  paidSpinsRemaining: number;
};

type Outcome = {
  position: number;
  emoji: string;
  prize: bigint;
  labelKey: string;
};

type SpinData = {
  outcome: Outcome;
  freeSpinsRemaining: number;
  paidSpinsRemaining: number;
  prizeTxHash?: string;
  feeTxHash?: string;
  balance: bigint;
};

function targetRotationForPosition(position: number, currentRotation: number, slotCount: number): number {
  const segment = 360 / slotCount;
  const desired = ((-(position * segment + segment / 2)) % 360 + 360) % 360;
  const delta = (desired - (currentRotation % 360) + 360) % 360;
  return currentRotation + 5 * 360 + delta;
}

function waitForTransition(element: HTMLElement | null, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (!element) {
      setTimeout(resolve, 4500);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      element.removeEventListener("transitionend", finish);
      resolve();
    };
    element.addEventListener("transitionend", finish);
    setTimeout(finish, timeoutMs);
  });
}

function impact(style: "light" | "medium" | "heavy") {
  if (!isHapticFeedbackSupported()) return;
  try {
    hapticFeedbackImpactOccurred(style);
  } catch {
    // haptics are best-effort
  }
}

function notify(type: "success" | "error" | "warning") {
  if (!isHapticFeedbackSupported()) return;
  try {
    hapticFeedbackNotificationOccurred(type);
  } catch {
    // haptics are best-effort
  }
}

function mapError(typedCode: string | undefined): string {
  switch (typedCode) {
    case "SESSION_INVALID":
    case "SESSION_EXPIRED":
    case "SESSION_USED":
      return "errors.session";
    case "RATE_LIMIT":
      return "errors.rateLimit";
    case "INSUFFICIENT_FUNDS":
      return "errors.insufficient";
    case "ACCOUNT_NOT_READY":
      return "errors.accountNotReady";
    case "POOL_UNAVAILABLE":
      return "errors.poolUnavailable";
    default:
      return "errors.generic";
  }
}

export function EspressoRoulette() {
  const t = useTranslations("game");
  const utils = trpc.useUtils();
  const sessionMutation = trpc.games.session.useMutation();
  const spinMutation = trpc.games.spin.useMutation();

  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<SessionData | null>(null);
  const [rotation, setRotation] = useState(0);
  const [result, setResult] = useState<SpinData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confetti, setConfetti] = useState(false);

  const rotationRef = useRef(0);
  const wheelRef = useRef<HTMLDivElement | null>(null);
  const retriedRef = useRef(false);

  const loadSession = useCallback(async (): Promise<SessionData | null> => {
    try {
      const next = await sessionMutation.mutateAsync();
      setError(null);
      return next;
    } catch (err) {
      const typedCode = (err as { data?: { typedCode?: string } } | null)?.data?.typedCode;
      setError(mapError(typedCode));
      return null;
    }
  }, [sessionMutation]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await loadSession();
      if (cancelled) return;
      setSession(next);
      setPhase("idle");
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSession]);

  async function performSpin(sessionData: SessionData, spinType: "free" | "paid") {
    setPhase("spinning");
    setError(null);
    try {
      const data = await spinMutation.mutateAsync({
        sessionId: sessionData.sessionId,
        nonce: sessionData.nonce,
        hmac: sessionData.hmac,
        spinType,
      });
      setResult(data);
      setConfetti(data.outcome.prize > 0n);
      const target = targetRotationForPosition(data.outcome.position, rotationRef.current, WHEEL_SLOTS.length);
      rotationRef.current = target;
      setRotation(target);
      await waitForTransition(wheelRef.current);
      setPhase("result");
      if (data.outcome.prize > 0n) {
        notify("success");
      } else {
        notify("error");
      }
      retriedRef.current = false;
      void utils.wallet.get.invalidate();
      const next = await loadSession();
      setSession(next);
    } catch (err) {
      const typedCode = (err as { data?: { typedCode?: string } } | null)?.data?.typedCode;
      if (
        !retriedRef.current &&
        (typedCode === "SESSION_INVALID" ||
          typedCode === "SESSION_EXPIRED" ||
          typedCode === "SESSION_USED")
      ) {
        retriedRef.current = true;
        const fresh = await loadSession();
        if (fresh) {
          await performSpin(fresh, spinType);
          return;
        }
      }
      retriedRef.current = false;
      setError(mapError(typedCode));
      setPhase("idle");
    }
  }

  function handleSpin() {
    if (!session || phase === "spinning") return;
    const spinType: "free" | "paid" = session.freeSpinsRemaining > 0 ? "free" : "paid";
    if (spinType === "paid" && session.paidSpinsRemaining <= 0) return;
    impact("medium");
    void performSpin(session, spinType);
  }

  const canSpin = Boolean(
    session && (session.freeSpinsRemaining > 0 || session.paidSpinsRemaining > 0),
  );
  const usingPaid = Boolean(session && session.freeSpinsRemaining === 0);
  const won = Boolean(result && result.outcome.prize > 0n);

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm opacity-70">{t("subtitle")}</p>

      <div ref={wheelRef} className="relative">
        <RouletteWheel slots={WHEEL_SLOTS} spinDeg={rotation} />
        {phase === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-white/60">
            <p className="rounded-xl bg-white p-3 text-sm shadow-sm">{t("loading")}</p>
          </div>
        )}
        {confetti && phase === "result" && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
            {Array.from({ length: 20 }).map((_, index) => (
              <span
                key={index}
                className="confetti-piece absolute top-0 block h-2 w-1 rounded-sm"
                style={{
                  left: `${(index * 53) % 100}%`,
                  background: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
                  animationDelay: `${(index % 5) * 0.12}s`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {session && (
        <div className="flex gap-3 text-sm opacity-70">
          <span>{t("spinsLeft", { n: session.freeSpinsRemaining })}</span>
          <span>{t("paidSpinsLeft", { n: session.paidSpinsRemaining })}</span>
        </div>
      )}

      {result && phase === "result" && (
        <div
          className={`w-full rounded-2xl p-4 text-center shadow-sm ${
            won ? "bg-green-100 text-green-900" : "bg-white text-foreground"
          }`}
        >
          <p className="text-3xl">{result.outcome.emoji}</p>
          <p className="mt-1 font-bold">{t(`slots.${result.outcome.labelKey}`)}</p>
          {won ? (
            <p className="mt-1">{t("youWon", { prize: result.outcome.prize.toString() })}</p>
          ) : (
            <p className="mt-1 opacity-70">{t("noWin")}</p>
          )}
        </div>
      )}

      {error && <p className="w-full rounded-xl bg-red-100 p-3 text-red-900">{t(error)}</p>}

      {canSpin && (
        <button
          type="button"
          onClick={handleSpin}
          disabled={phase === "spinning"}
          className="w-full rounded-xl bg-accent px-4 py-3 text-lg font-bold text-white disabled:opacity-40"
        >
          {phase === "spinning"
            ? t("spinning")
            : usingPaid
              ? t("paidSpin", { cost: session?.paidSpinCost.toString() ?? "" })
              : t("spin")}
        </button>
      )}
    </div>
  );
}
