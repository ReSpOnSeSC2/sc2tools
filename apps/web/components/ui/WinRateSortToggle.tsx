"use client";

import type { SortDir } from "./SortableTh";

/**
 * WinRateSortToggle — shared "sort by win rate" direction control.
 *
 * Renders a two-option segmented control (High → Low / Low → High) so
 * the user can order any win-rate list without needing the desktop
 * table headers, which collapse to stacked cards on mobile. Mirrors
 * the look + a11y of ``MinGamesPicker`` (radiogroup, 32px hit targets)
 * so the Strategies filter row stays visually consistent across
 * surfaces.
 *
 * ``dir`` is the currently selected direction and ``active`` reflects
 * whether win rate is the column actually being sorted (false when a
 * sibling control — e.g. a "Games" table header — owns the sort). When
 * inactive, no option is highlighted, but clicking one still takes over
 * the sort with the chosen direction.
 */
export interface WinRateSortToggleProps {
  dir: SortDir;
  onChange: (dir: SortDir) => void;
  /** Whether win rate is the active sort column. Defaults to true. */
  active?: boolean;
  /** Hide the "Win rate" caption (e.g. when caller renders its own). */
  hideLabel?: boolean;
  /** Append extra layout classes to the outer flex container. */
  className?: string;
}

const OPTIONS: ReadonlyArray<{ dir: SortDir; label: string; title: string }> = [
  {
    dir: "desc",
    label: "High → Low",
    title: "Sort win rate from highest to lowest",
  },
  {
    dir: "asc",
    label: "Low → High",
    title: "Sort win rate from lowest to highest",
  },
];

export function WinRateSortToggle({
  dir,
  onChange,
  active = true,
  hideLabel = false,
  className = "",
}: WinRateSortToggleProps) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {!hideLabel && (
        <span className="text-micro uppercase tracking-wider text-text-dim">
          Win rate
        </span>
      )}
      <div
        role="radiogroup"
        aria-label="Sort by win rate"
        className="inline-flex overflow-hidden rounded-lg border-2 border-line"
      >
        {OPTIONS.map((o) => {
          const selected = active && dir === o.dir;
          return (
            <button
              key={o.dir}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.dir)}
              title={o.title}
              className={`min-h-[32px] whitespace-nowrap px-2.5 text-xs tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                selected
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:bg-bg-elevated"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
