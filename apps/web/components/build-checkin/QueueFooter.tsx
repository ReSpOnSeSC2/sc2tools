"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import {
  BUILD_CHECKIN_SETTINGS_HREF,
  buildIntentErrorMessage,
  dismissPendingIntents,
} from "@/lib/buildIntent";
import type { ConfirmAllProgress } from "./useConfirmAllSuggested";

/**
 * The queue dialog's footer: the settings link, "Confirm all suggested
 * (N)" (two or more games with a suggestion) and "Dismiss all", each
 * behind an inline confirmation, plus the live summary of a confirm-all
 * run with its Retry.
 */
export function QueueFooter({
  count,
  disabled,
  suggestedCount,
  retryCount,
  progress,
  onClose,
  onDismissed,
  onConfirmAll,
  onRetry,
}: {
  count: number;
  disabled: boolean;
  /** Games still waiting that carry a suggestion. */
  suggestedCount: number;
  retryCount: number;
  progress: ConfirmAllProgress;
  onClose: () => void;
  onDismissed: () => void;
  onConfirmAll: () => void;
  onRetry: () => void;
}) {
  const { getToken } = useAuth();
  const toastContext = useToastOptional();
  const [asking, setAsking] = useState<"dismiss" | "confirm" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = progress.phase === "running";

  const dismissAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await dismissPendingIntents(getToken);
      const dismissed = typeof result?.dismissed === "number" ? result.dismissed : count;
      toastContext?.toast.success(
        dismissed === 1 ? "Dismissed 1 check-in" : `Dismissed ${dismissed} check-ins`,
      );
      setAsking(null);
      onDismissed();
    } catch (err) {
      const message = buildIntentErrorMessage(err);
      setError(message);
      toastContext?.toast.error("Couldn't dismiss check-ins", { description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Link
        href={BUILD_CHECKIN_SETTINGS_HREF}
        onClick={onClose}
        className="inline-flex min-h-11 items-center gap-1.5 rounded text-caption font-semibold text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Settings2 className="h-4 w-4" aria-hidden />
        Check-in settings
      </Link>
      {asking === "dismiss" ? (
        <div
          role="group"
          aria-label="Confirm dismiss all"
          className="flex flex-wrap items-center justify-end gap-2"
        >
          <span className="text-caption text-text">
            Mark {count === 1 ? "this game" : `all ${count} games`} as no set build?
          </span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking(null)}>
            Cancel
          </Button>
          <Button size="sm" loading={busy} onClick={() => void dismissAll()}>
            Dismiss all
          </Button>
        </div>
      ) : asking === "confirm" ? (
        <div
          role="group"
          aria-label="Confirm all suggested"
          className="flex flex-wrap items-center justify-end gap-2"
        >
          <span className="text-caption text-text">
            Confirm {suggestedCount} suggested build{suggestedCount === 1 ? "" : "s"}?
          </span>
          <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={suggestedCount === 0}
            onClick={() => {
              setAsking(null);
              onConfirmAll();
            }}
          >
            Confirm
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {suggestedCount >= 2 ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || running}
              onClick={() => setAsking("confirm")}
            >
              Confirm all suggested ({suggestedCount})
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || running || count === 0}
            onClick={() => setAsking("dismiss")}
          >
            Dismiss all
          </Button>
        </div>
      )}
      <ConfirmAllSummary
        progress={progress}
        remaining={disabled ? 0 : retryCount}
        onRetry={onRetry}
      />
      {error ? (
        <p role="alert" className="w-full text-right text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Confirming 3 of 7…", "Paused: … Retry remaining (4)" or "Confirmed 6
 * of 7. 1 failed. Retry". Always rendered, so the live region announces
 * each change.
 */
function ConfirmAllSummary({
  progress,
  remaining,
  onRetry,
}: {
  progress: ConfirmAllProgress;
  /** Games a retry would confirm. */
  remaining: number;
  onRetry: () => void;
}) {
  const { phase, total, confirmed, failed, pausedReason } = progress;
  let text = "";
  let retry: string | null = null;
  if (phase === "running") {
    text = `Confirming ${Math.min(total, confirmed + failed + 1)} of ${total}…`;
  } else if (phase === "paused") {
    text = `Paused: ${pausedReason ?? "the check-ins stopped."}`;
    if (remaining > 0) retry = `Retry remaining (${remaining})`;
  } else if (phase === "finished") {
    text = `Confirmed ${confirmed} of ${total}.${failed > 0 ? ` ${failed} failed.` : ""}`;
    if (failed > 0 && remaining > 0) retry = "Retry";
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className={text ? "flex w-full flex-wrap items-center justify-end gap-2 text-caption text-text" : "sr-only"}
      data-testid="confirm-all-summary"
    >
      {text ? <span>{text}</span> : null}
      {retry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {retry}
        </Button>
      ) : null}
    </div>
  );
}
