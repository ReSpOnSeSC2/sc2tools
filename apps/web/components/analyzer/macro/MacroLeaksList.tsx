"use client";

import { Clock, TrendingDown } from "lucide-react";
import { formatGameClock, leakKey } from "@/lib/macro";
import type { LeakItem } from "./MacroBreakdownPanel.types";

export interface MacroLeaksListProps {
  leaks: LeakItem[];
  /** Stable identifier of the currently-highlighted leak (drives the chart marker). */
  highlightedKey?: string | null;
  /** Fired when the user clicks/keys a leak. Pass null to clear. */
  onSelect?: (key: string | null, leak: LeakItem | null) => void;
  /** Optional cap — defaults to all leaks. The SPA shows top 3. */
  limit?: number;
  /** Eyebrow caption rendered above the list. */
  caption?: string;
}

/**
 * MacroLeaksList — top-N leak callouts. Each leak is a button so the
 * keyboard / screen-reader experience matches the click-to-highlight
 * mouse interaction. When `onSelect` is omitted the list renders as
 * static information (still readable, no focus rings).
 */
export function MacroLeaksList({
  leaks,
  highlightedKey,
  onSelect,
  limit,
  caption,
}: MacroLeaksListProps) {
  const visible = typeof limit === "number" ? leaks.slice(0, limit) : leaks;
  const interactive = typeof onSelect === "function";

  if (visible.length === 0) {
    return (
      <div className="rounded-md border border-border bg-bg-subtle p-3 text-caption text-text-muted">
        No notable leaks detected for this game.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {caption ? (
        <p className="text-caption uppercase tracking-wider text-danger">
          {caption}
        </p>
      ) : null}
      <ul className="space-y-2">
        {visible.map((leak, idx) => {
          const id = leakKey(leak, idx);
          const selected = id === highlightedKey;
          return (
            <li key={id}>
              <LeakRow
                leak={leak}
                selected={selected}
                onClick={
                  interactive
                    ? () => onSelect!(selected ? null : id, selected ? null : leak)
                    : undefined
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LeakRow({
  leak,
  selected,
  onClick,
}: {
  leak: LeakItem;
  selected: boolean;
  onClick?: () => void;
}) {
  const label = leak.name || "Unnamed leak";
  const detail = leak.detail || "";
  const points =
    typeof leak.penalty === "number" && leak.penalty > 0
      ? leak.penalty.toFixed(1)
      : null;
  const minerals =
    typeof leak.mineral_cost === "number" && leak.mineral_cost > 0
      ? Math.round(leak.mineral_cost)
      : null;
  const time = typeof leak.time === "number" ? formatGameClock(leak.time) : null;

  const baseClass =
    "block w-full rounded-md border bg-bg-subtle px-3 py-2 text-left transition-colors";
  const stateClass = selected
    ? "border-accent-cyan ring-1 ring-accent-cyan/40 bg-bg-elevated"
    : "border-border hover:border-border-strong";

  const inner = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <TrendingDown className="h-3.5 w-3.5 flex-shrink-0 text-danger" aria-hidden />
        <span className="text-caption font-semibold text-text">{label}</span>
        {time ? (
          <span className="inline-flex items-center gap-1 text-[11px] tabular-nums text-text-dim">
            <Clock className="h-3 w-3" aria-hidden />
            {time}
          </span>
        ) : null}
        {points ? (
          <span className="ml-auto text-[11px] font-semibold tabular-nums text-danger">
            -{points} pts
          </span>
        ) : null}
      </div>
      {detail ? (
        <p className="mt-1 text-[11px] text-text-muted">{detail}</p>
      ) : null}
      {minerals != null ? (
        <p className="mt-1 text-[11px] text-warning">~{minerals} min lost</p>
      ) : null}
    </>
  );

  if (!onClick) {
    return (
      <div className={[baseClass, "border-border"].join(" ")}>{inner}</div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        baseClass,
        stateClass,
        "min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      ].join(" ")}
    >
      {inner}
    </button>
  );
}
