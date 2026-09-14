"use client";

import type { ReactNode } from "react";
import { AlertCircle, ArrowUpRight, RefreshCw } from "lucide-react";

export const CONTROL_CLASS = "min-h-11 w-full min-w-0 rounded-lg border border-border-strong bg-bg-surface px-3 py-2 text-sm text-text shadow-none outline-none transition focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";
export const ACTION_CLASS = "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border-strong bg-bg-surface px-3 py-2 text-xs font-semibold text-text transition hover:border-accent hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";

export function ExplorerField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-text-muted">
    <label className="flex min-w-0 flex-col gap-1.5"><span>{label}</span>{children}</label>
    {hint ? <span className="text-[11px] font-normal leading-relaxed text-text-dim">{hint}</span> : null}
  </div>;
}

export function ExplorerLoading({ title }: { title: string }) {
  return <div role="status" aria-label={`Loading ${title}`} className="space-y-5 py-4">
    <span className="sr-only">Loading {title}</span>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{[0, 1, 2].map((n) => <div key={n} className={`h-20 animate-pulse rounded-xl bg-bg-elevated ${n === 2 ? "hidden sm:block" : ""}`} />)}</div>
    <div className="h-56 animate-pulse rounded-xl bg-bg-elevated" />
  </div>;
}

export function ExplorerError({ message, retry }: { message: string; retry: () => unknown }) {
  return <div role="alert" className="my-4 flex flex-col items-start gap-3 rounded-xl border border-danger/25 bg-danger/5 p-4 sm:flex-row sm:items-center">
    <AlertCircle aria-hidden className="h-5 w-5 shrink-0 text-danger" />
    <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-text">This analysis couldn’t load</p><p className="mt-1 break-words text-xs text-text-muted">{message}</p></div>
    <button type="button" className={ACTION_CLASS} onClick={() => { void retry(); }}><RefreshCw aria-hidden className="h-3.5 w-3.5" />Retry</button>
  </div>;
}

export function ExplorerStat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div className="min-w-0 rounded-xl border border-border bg-bg-elevated/50 p-3 sm:p-4">
    <p className="text-[11px] font-medium text-text-muted">{label}</p>
    <p className="mt-1 break-words text-xl font-semibold tabular-nums tracking-tight text-text sm:text-2xl">{value}</p>
    {detail ? <p className="mt-1 text-[11px] leading-relaxed text-text-dim">{detail}</p> : null}
  </div>;
}

export function GamesButton({ onClick, label = "View games", disabled = false }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold text-accent transition hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40" aria-label={label}>View games<ArrowUpRight aria-hidden className="h-3.5 w-3.5" /></button>;
}

export function formatCount(value: number | null | undefined) { return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(); }
export function formatRate(value: number | null | undefined) { return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`; }
export function formatSeconds(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const total = Math.max(0, Math.round(value));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
export function formatSigned(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}
