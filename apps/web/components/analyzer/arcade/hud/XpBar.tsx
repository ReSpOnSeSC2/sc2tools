"use client";

import { xpForNextLevel } from "../ArcadeEngine";

/**
 * XpBar — slim progress bar for the current level + XP-toward-next-level.
 * Pure presentation; level math happens once in useArcadeState.
 */
export function XpBar({ xp, level }: { xp: number; level: number }) {
  const { current, needed } = xpForNextLevel(xp);
  const pct = needed > 0 ? Math.min(100, Math.round((current / needed) * 100)) : 0;
  return (
    <div className="flex min-w-[140px] items-center gap-2">
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-caption font-bold tabular-nums text-accent">
        Lv {level}
      </span>
      <div className="flex flex-1 flex-col gap-0.5">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={needed}
          aria-valuenow={current}
          aria-label={`${current} of ${needed} XP toward level ${level + 1}`}
          className="h-1.5 w-full overflow-hidden rounded bg-bg-elevated"
        >
          <div
            className="h-full bg-accent-cyan transition-[width] duration-150 motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-[10px] tabular-nums text-text-dim">
          {current} / {needed} XP
        </span>
      </div>
    </div>
  );
}
