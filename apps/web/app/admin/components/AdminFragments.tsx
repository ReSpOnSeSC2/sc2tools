"use client";

import { Card } from "@/components/ui/Card";

/**
 * Small presentational primitives reused across admin tabs. Kept in
 * one file because each fragment is too small to deserve its own
 * module and they're only used inside ``/admin/*``.
 */

export function ForbiddenCard() {
  return (
    <Card padded>
      <div className="flex flex-col items-start gap-2">
        <span className="inline-flex items-center gap-2 rounded-full bg-warning/15 px-3 py-1 text-caption font-semibold text-warning">
          403 — admin only
        </span>
        <p className="text-text-muted">
          Your account isn&apos;t on the admin list. Ask an existing
          admin to add your Clerk user id to{" "}
          <code className="font-mono text-text">SC2TOOLS_ADMIN_USER_IDS</code>.
        </p>
      </div>
    </Card>
  );
}

export function MetricStat({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <Card padded>
      <div className="flex flex-col gap-1">
        <span className="text-caption font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </span>
        <span className="text-2xl font-semibold tabular-nums text-text">
          {value}
        </span>
        {caption ? (
          <span className="text-caption text-text-dim">{caption}</span>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Shimmer rows used while a list is loading. Same height/spacing as
 * the real table so the layout doesn't jump when data arrives.
 */
export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <Card padded={false}>
      <ul className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i} className="flex animate-pulse gap-4 px-4 py-3">
            <div className="h-4 w-1/4 rounded bg-bg-elevated" />
            <div className="h-4 w-1/6 rounded bg-bg-elevated" />
            <div className="h-4 w-1/6 rounded bg-bg-elevated" />
            <div className="h-4 flex-1 rounded bg-bg-elevated" />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Inline confirmation prompt for destructive actions. Used by the
 * Tools and Users tabs so destructive buttons require an explicit
 * "yes" before firing — no separate modal so the UX stays inline
 * with the row that triggered it.
 */
export function ConfirmInline({
  prompt,
  onConfirm,
  onCancel,
  busy = false,
  confirmLabel = "Confirm",
  variant = "danger",
}: {
  prompt: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  confirmLabel?: string;
  variant?: "danger" | "primary";
}) {
  const tone =
    variant === "danger"
      ? "btn-danger"
      : "bg-accent text-white hover:bg-accent/90";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated/40 p-3 sm:flex-row sm:items-center sm:gap-3">
      <p className="flex-1 text-caption text-text">{prompt}</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-secondary text-sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`btn text-sm ${tone}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </div>
  );
}
