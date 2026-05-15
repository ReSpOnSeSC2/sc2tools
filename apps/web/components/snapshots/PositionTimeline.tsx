"use client";

import { useMemo } from "react";
import {
  VERDICT_COLORS,
  VERDICT_GLYPHS,
  VERDICT_LABELS,
} from "./shared/colorScales";
import {
  fmtTick,
  type GameTick,
  type SnapshotVerdict,
} from "./shared/snapshotTypes";

// 40-cell heat-row across the timeline. Each cell is one 30 s tick;
// fill encodes the verdict (with a glyph for colorblind redundancy).
// Tap (mobile) or click (desktop) pins the cursor onto that tick.
// On mobile the row scrolls horizontally via snap; on desktop it
// fills the column width.

export interface PositionTimelineProps {
  ticks: GameTick[];
  focusedTick: number | null;
  onFocus: (t: number) => void;
  pinned?: boolean;
  onPinToggle?: () => void;
}

export function PositionTimeline({
  ticks,
  focusedTick,
  onFocus,
  pinned = false,
  onPinToggle,
}: PositionTimelineProps) {
  const cells = useMemo(() => buildCells(ticks), [ticks]);

  return (
    <div className="rounded-xl border border-border bg-bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-caption font-semibold text-text">Position over time</h3>
        {onPinToggle ? (
          <button
            type="button"
            onClick={onPinToggle}
            aria-pressed={pinned}
            className={[
              "rounded-md px-2 py-1 text-[11px] font-medium",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              pinned
                ? "bg-accent text-white"
                : "border border-border text-text-muted hover:text-text",
            ].join(" ")}
          >
            {pinned ? "Pinned · arrows to move" : "Tap to pin"}
          </button>
        ) : null}
      </div>
      <div
        className="flex snap-x snap-mandatory gap-0.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-x-visible"
        role="listbox"
        aria-label="Tick timeline"
      >
        {cells.map((cell) => {
          const isFocused = focusedTick === cell.t;
          return (
            <button
              key={cell.t}
              type="button"
              role="option"
              aria-selected={isFocused}
              aria-label={`${fmtTick(cell.t)} — ${VERDICT_LABELS[cell.verdict]}`}
              onClick={() => onFocus(cell.t)}
              onMouseEnter={() => !pinned && onFocus(cell.t)}
              className={[
                "relative flex h-9 w-9 shrink-0 snap-start items-center justify-center rounded-sm text-[10px] font-semibold",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                isFocused ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : "",
              ].join(" ")}
              style={{
                background: VERDICT_COLORS[cell.verdict],
                color: cell.verdict === "neutral" ? "#0b0d12" : "#fff",
              }}
            >
              <span aria-hidden>{VERDICT_GLYPHS[cell.verdict]}</span>
              {cell.t % 180 === 0 ? (
                <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-text-dim">
                  {fmtTick(cell.t)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex flex-wrap gap-3 text-[10px] text-text-dim">
        {(Object.keys(VERDICT_LABELS) as SnapshotVerdict[])
          .filter((v) => v !== "unknown")
          .map((v) => (
            <span key={v} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-flex h-3 w-3 items-center justify-center rounded-sm text-[8px] font-bold text-white"
                style={{ background: VERDICT_COLORS[v] }}
              >
                {VERDICT_GLYPHS[v]}
              </span>
              {VERDICT_LABELS[v]}
            </span>
          ))}
      </div>
    </div>
  );
}

function buildCells(ticks: GameTick[]) {
  return ticks.map((t) => ({ t: t.t, verdict: t.verdict }));
}
