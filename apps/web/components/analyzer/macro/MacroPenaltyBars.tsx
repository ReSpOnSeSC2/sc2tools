"use client";

import type { PenaltyRow } from "./MacroBreakdownPanel.types";

export interface MacroPenaltyBarsProps {
  rows: PenaltyRow[];
  /** Optional headline copy rendered above the bar chart. */
  caption?: string;
}

const MAX_BAR_FRACTION = 0.95;
const BAR_FLOOR_PCT = 4;

const TRACK_COLOR = "var(--color-border-track, rgb(var(--border)))";

const TONE_FILL: Record<PenaltyRow["tone"], string> = {
  danger: "rgb(var(--danger))",
  success: "rgb(var(--success))",
  neutral: "rgb(var(--text-muted))",
};

const TONE_LABEL: Record<PenaltyRow["tone"], string> = {
  danger: "text-danger",
  success: "text-success",
  neutral: "text-text-muted",
};

/**
 * Horizontal bar chart breaking the headline score loss across the
 * three macro disciplines (supply blocks, race mechanic, mineral
 * float). Each row is a track + filled bar; tracks always render so
 * the visual weight stays balanced even when a category is clean.
 *
 * The chart is responsive — bars scale to container width — and uses
 * tabular-nums for the trailing point counts so columns don't dance.
 */
export function MacroPenaltyBars({ rows, caption }: MacroPenaltyBarsProps) {
  const peak = rows.reduce((m, r) => (r.value > m ? r.value : m), 0);
  const scale = peak <= 0 ? 0 : peak;

  return (
    <div
      role="group"
      aria-label="Macro score penalties by category"
      className="space-y-2"
    >
      {caption ? (
        <p className="text-caption text-text-muted">{caption}</p>
      ) : null}
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-caption text-text">{row.label}</span>
              <span
                className={`text-caption font-semibold tabular-nums ${TONE_LABEL[row.tone]}`}
                aria-label={`${row.label}: ${row.value > 0 ? "lost" : "no"} ${row.value.toFixed(1)} points`}
              >
                {row.value > 0 ? `-${row.value.toFixed(1)}` : "0.0"} pts
              </span>
            </div>
            <Track value={row.value} scale={scale} tone={row.tone} label={row.label} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Track({
  value,
  scale,
  tone,
  label,
}: {
  value: number;
  scale: number;
  tone: PenaltyRow["tone"];
  label: string;
}) {
  const fillPct = barFillPercent(value, scale);
  return (
    <div
      className="relative h-2 overflow-hidden rounded-full border border-border"
      style={{ background: TRACK_COLOR }}
      role="presentation"
    >
      <div
        className="h-full rounded-full transition-[width] duration-200"
        style={{
          width: `${fillPct}%`,
          background: TONE_FILL[tone],
          opacity: value > 0 ? 1 : 0.35,
        }}
        aria-hidden
      />
      <span className="sr-only">
        {label} bar fills to {Math.round(fillPct)} percent of the worst category.
      </span>
    </div>
  );
}

function barFillPercent(value: number, scale: number): number {
  if (value <= 0) return BAR_FLOOR_PCT;
  if (scale <= 0) return BAR_FLOOR_PCT;
  const ratio = Math.min(1, value / scale) * MAX_BAR_FRACTION;
  return Math.max(BAR_FLOOR_PCT, ratio * 100);
}
