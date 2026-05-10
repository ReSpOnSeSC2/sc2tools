"use client";

import { Flame } from "lucide-react";

/**
 * StreakHUD — pill rendered in the Arcade tab header. Shows the current
 * daily streak with a flame icon. Aria-live so screen readers announce
 * a streak change once.
 */
export function StreakHUD({ streak }: { streak: number }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-2.5 text-caption font-semibold text-text"
    >
      <Flame
        className={[
          "h-4 w-4 flex-shrink-0",
          streak > 0 ? "text-warning" : "text-text-dim",
        ].join(" ")}
        aria-hidden
      />
      <span className="font-mono tabular-nums">{streak}</span>
      <span className="text-text-dim">day{streak === 1 ? "" : "s"}</span>
    </span>
  );
}
