"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Clock, Copy, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import {
  requestErrorCopy,
  requestErrorKind,
  toClientApiError,
  type RequestErrorCopy,
  type RequestErrorKind,
} from "@/lib/requestErrors";

/**
 * RequestError — what a section shows when its data request failed:
 * a plain explanation of what went wrong, a Retry button and, when the
 * API sent one, the Error ID to quote in a report.
 *
 *   <RequestError error={q.error} onRetry={q.mutate} filtered />
 *
 * Copy follows the failure (lib/requestErrors.ts): "Can't reach SC2
 * Tools" for a dropped connection or a server that is waking up, "The
 * server is busy" for a 503, "You're signed out" for a 401, and so on.
 * Waiting-type failures (connection, timeout, busy, rate limit) use the
 * warning tone; the rest use danger.
 *
 * Usually rendered by <QueryState>; use it directly where a view owns
 * its own loading logic.
 */
export interface RequestErrorProps {
  /** What the request threw: a ClientApiError from useApi, or anything else. */
  error: unknown;
  /** Called by Retry; pass the SWR response's `mutate`. Omit to hide Retry. */
  onRetry?: () => unknown;
  /**
   * Wraps the message in a Card with this heading, for a section whose
   * whole card failed. Omit when the panel already sits inside a card.
   */
  title?: ReactNode;
  /** Adds "Your filters are still applied." Set it on analyzer views. */
  filtered?: boolean;
  /** Replace the title or body for some kinds of failure. */
  copy?: Partial<Record<RequestErrorKind, Partial<RequestErrorCopy>>>;
  className?: string;
}

const WAITING_KINDS: ReadonlySet<RequestErrorKind> = new Set([
  "network",
  "timeout",
  "busy",
  "rate_limited",
]);

export function RequestError({
  error,
  onRetry,
  title,
  filtered = false,
  copy,
  className = "",
}: RequestErrorProps) {
  const kind = requestErrorKind(error);
  const base = requestErrorCopy(error);
  const text = { ...base, ...copy?.[kind] };
  const requestId = toClientApiError(error).requestId;
  const waiting = WAITING_KINDS.has(kind);
  const Icon = kind === "network" ? WifiOff : kind === "timeout" ? Clock : AlertTriangle;

  const panel = (
    <div
      role="alert"
      data-testid="request-error"
      className={[
        "rounded-lg border px-3 py-3 sm:px-4",
        waiting ? "border-warning/40 bg-warning/5" : "border-danger/30 bg-danger/5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={["mt-0.5 h-5 w-5 shrink-0", waiting ? "text-warning" : "text-danger"].join(" ")}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-body font-semibold text-text">{text.title}</p>
          <p className="text-caption text-text-muted">
            {text.body}
            {filtered ? " Your filters are still applied." : null}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
            {onRetry ? <RetryButton onRetry={onRetry} /> : null}
            {kind === "signed_out" ? (
              <Link
                href="/sign-in"
                className="inline-flex min-h-9 items-center rounded-md text-caption font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Sign in again
              </Link>
            ) : null}
            {requestId ? <ErrorId id={requestId} /> : null}
            <LazyHelpLink slug="something-went-wrong" className="text-caption">
              What does this mean?
            </LazyHelpLink>
          </div>
        </div>
      </div>
    </div>
  );

  return title !== undefined ? <Card title={title}>{panel}</Card> : panel;
}

/**
 * Retry stays focusable while the request runs (a disabled button
 * would drop keyboard focus); it reports aria-busy and ignores repeat
 * presses instead. When the panel is still here after a retry, the
 * request failed again, and a polite status line says so.
 */
function RetryButton({ onRetry }: { onRetry: () => unknown }) {
  const [retrying, setRetrying] = useState(false);
  const [failedAgain, setFailedAgain] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setFailedAgain(false);
    try {
      await onRetry();
    } catch {
      // SWR keeps the error on the response, so this panel stays up.
    } finally {
      if (mounted.current) {
        setRetrying(false);
        setFailedAgain(true);
      }
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        aria-busy={retrying || undefined}
        aria-disabled={retrying || undefined}
        onClick={() => {
          void retry();
        }}
        iconLeft={
          <RefreshCw
            className={["h-4 w-4", retrying ? "motion-safe:animate-spin" : ""].join(" ")}
            aria-hidden
          />
        }
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
      <span role="status" className="sr-only">
        {retrying ? "Retrying." : failedAgain ? "Still not loading. Try again in a moment." : ""}
      </span>
    </>
  );
}

/**
 * "Error ID: 1a2b3c4d" plus Copy. The first eight characters are enough
 * to find the request in the server logs; Copy takes the whole id.
 */
function ErrorId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure context, permissions): the id stays
      // visible and selectable.
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-text-muted">
      Error ID:
      <code className="select-all font-mono text-micro text-text" title={id}>
        {id.slice(0, 8)}
      </code>
      <button
        type="button"
        onClick={() => {
          void copy();
        }}
        aria-label={copied ? "Error ID copied" : "Copy error ID"}
        className="inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-caption font-medium text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        <span aria-hidden>{copied ? "Copied" : "Copy"}</span>
      </button>
    </span>
  );
}
