"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/** The bits of a failed request this card shows (ClientApiError fits). */
export interface BuildLoadErrorDetails {
  message?: string;
  requestId?: string;
}

export interface BuildLoadErrorProps {
  title: string;
  error: BuildLoadErrorDetails | null | undefined;
  /** Re-runs the failed request (an SWR `mutate`). */
  onRetry: () => unknown;
  /** Extra actions after Retry, such as a "Back to library" link. */
  actions?: ReactNode;
}

const COPIED_RESET_MS = 2000;

/**
 * A request on a build page failed (anything but a 404): says so, offers
 * Retry, and shows the API's request id with a copy button so a support
 * message can quote it. Never claims the build has no data.
 */
export function BuildLoadError({ title, error, onRetry, actions }: BuildLoadErrorProps) {
  const [retrying, setRetrying] = useState(false);
  // ClientApiError messages are already written for people.
  const message =
    error?.message?.trim() || "Something went wrong on our side. Try again in a moment.";

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Card>
      <div role="alert" className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <AlertTriangle className="h-6 w-6 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-body font-semibold text-text">{title}</h2>
          <p className="break-words text-caption text-text-muted">{message}</p>
          {error?.requestId ? <ErrorId id={error.requestId} /> : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 sm:pl-10">
        <Button
          variant="secondary"
          onClick={() => void retry()}
          loading={retrying}
          iconLeft={<RotateCw className="h-4 w-4" aria-hidden />}
        >
          Retry
        </Button>
        {actions}
      </div>
    </Card>
  );
}

/** "Error ID: abc123 (Copy)": the request id, copyable for a support message. */
function ErrorId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // Clipboard blocked: the id stays visible and selectable.
    }
  }

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-text-muted">
      <span>
        Error ID:{" "}
        <span className="select-all break-all font-mono text-text">{id}</span>
      </span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Error ID copied" : "Copy error ID"}
        className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 font-medium text-accent-cyan hover:bg-bg-elevated hover:text-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Error ID copied" : ""}
      </span>
    </p>
  );
}
