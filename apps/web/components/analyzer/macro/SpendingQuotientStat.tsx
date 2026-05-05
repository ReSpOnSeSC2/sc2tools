"use client";

import { useState, type ReactNode } from "react";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { tierFromSq } from "@/lib/macro";

export interface SpendingQuotientStatProps {
  label: string;
  /** Numeric value (SQ, blocked-seconds, float-spikes, etc). */
  value: number | null | undefined;
  /** Hint shown beneath the value — e.g. "Master tier" or "low is better". */
  hint?: ReactNode;
  /** Long-form explanation surfaced on hover / tap. */
  explanation: string;
  /** Stat tone affecting the value colour. */
  tone?: "cyan" | "warning" | "danger" | "neutral";
  /** Surface a soft cyan glow behind the card (used for the headline SQ). */
  glow?: boolean;
  /** Optional unit suffix rendered inline with the value, e.g. "s" or "spikes". */
  unit?: string;
  /** Render value with one decimal (e.g. SQ scores 80.5). */
  decimals?: 0 | 1;
}

const TONE_CLASS: Record<NonNullable<SpendingQuotientStatProps["tone"]>, string> = {
  cyan: "text-accent-cyan",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-text",
};

/**
 * SpendingQuotientStat — small KPI tile used in the panel's top row.
 * Each tile shows a label, a numeric value, optional hint, and an
 * explanation that surfaces on hover/focus (kept tap-accessible via
 * onClick toggle on touch devices).
 */
export function SpendingQuotientStat({
  label,
  value,
  hint,
  explanation,
  tone = "neutral",
  glow = false,
  unit,
  decimals = 0,
}: SpendingQuotientStatProps) {
  const [expanded, setExpanded] = useState(false);
  const formatted = formatValue(value, decimals);
  const tier = tone === "cyan" ? tierFromSq(typeof value === "number" ? value : null) : null;

  const card = (
    <div
      className={[
        "relative flex h-full flex-col gap-1 rounded-lg border bg-bg-elevated p-3",
        glow ? "border-accent-cyan/40" : "border-border",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-dim">
          {label}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? `Hide ${label} explanation` : `Show ${label} explanation`}
          className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full border border-border text-[10px] font-semibold text-text-muted hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          ?
        </button>
      </div>
      <div className={`text-h2 font-semibold tabular-nums leading-none ${TONE_CLASS[tone]}`}>
        {formatted}
        {unit ? <span className="ml-0.5 text-body font-normal text-text-muted">{unit}</span> : null}
      </div>
      {tier ? (
        <div className="text-caption font-medium text-accent-cyan">{tier} tier</div>
      ) : null}
      {hint ? <div className="text-caption text-text-muted">{hint}</div> : null}
      {expanded ? (
        <p
          role="note"
          className="rounded-md border border-border bg-bg-subtle p-2 text-caption text-text-muted"
        >
          {explanation}
        </p>
      ) : null}
    </div>
  );

  if (!glow) return card;

  return (
    <div className="relative isolate overflow-hidden rounded-lg shadow-halo-cyan">
      <GlowHalo color="cyan" position="top-left" size={120} opacity={0.9} />
      {card}
    </div>
  );
}

function formatValue(value: number | null | undefined, decimals: 0 | 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return decimals === 1 ? value.toFixed(1) : Math.round(value).toString();
}
