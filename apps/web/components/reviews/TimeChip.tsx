"use client";

import { Clock } from "lucide-react";
import { formatClock } from "@/lib/reviews";

/**
 * A comment's moment on the replay ("5:12" or "5:12–5:40"). Activating
 * it seeks the replayer there and pauses, so the reviewer's point is on
 * screen when the reader looks up.
 */
export function TimeChip({
  startSec,
  endSec,
  onSeek,
  active = false,
}: {
  startSec: number;
  endSec?: number | null;
  onSeek: (seconds: number) => void;
  active?: boolean;
}) {
  const label = typeof endSec === "number"
    ? `${formatClock(startSec)}–${formatClock(endSec)}`
    : formatClock(startSec);
  return (
    <button
      type="button"
      onClick={() => onSeek(startSec)}
      aria-label={`Jump to ${label} in the replay`}
      aria-pressed={active}
      data-testid="review-time-chip"
      className={[
        "inline-flex min-h-[32px] items-center gap-1 rounded-full border px-2.5 font-mono text-caption font-semibold tabular-nums",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "border-accent-cyan bg-accent-cyan/20 text-text"
          : "border-border bg-bg-elevated text-accent-cyan hover:border-accent-cyan",
      ].join(" ")}
    >
      <Clock className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}
