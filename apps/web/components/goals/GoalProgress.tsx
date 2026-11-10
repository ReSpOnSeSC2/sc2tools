"use client";

import Link from "next/link";
import { goalDeepLink, periodLabel, progressText, sampleGuard, streakText, type Goal } from "@/lib/goals";

/**
 * One goal's progress: label, period, a bar and the line under it. While a
 * rate or average is still below its minimum sample, the bar fills toward
 * that sample instead (dashed, neutral) and the guard says how many games
 * are left — a rate from 9 games is never shown as if it counted.
 */
export function GoalProgress({ goal, compact = false }: { goal: Goal; compact?: boolean }) {
  const p = goal.progress;
  const guard = sampleGuard(goal);
  const percent = Math.round(100 * Math.max(0, Math.min(1, p?.fraction ?? 0)));
  const met = p?.state === "met" || goal.outcome === "met";
  const sampling = p?.phase === "sample";
  const streak = compact ? null : streakText(goal);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="min-w-0 break-words text-body font-medium text-text">{goal.label}</p>
        <span className="shrink-0 text-micro uppercase tracking-wider text-text-dim">{periodLabel(goal)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${goal.label}: ${sampling ? "sample" : "progress"}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={guard ?? progressText(goal)}
        className="h-2 overflow-hidden rounded-full bg-bg-elevated"
      >
        <div
          className={[
            "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
            met ? "bg-success" : sampling ? "bg-text-dim/50" : "bg-accent-cyan",
          ].join(" ")}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption">
        <span className="tabular-nums text-text-muted">{guard ?? progressText(goal)}</span>
        <span className="flex items-center gap-3">
          {met ? <span className="font-medium text-success">Reached</span> : null}
          {streak ? <span className="text-text-dim">{streak}</span> : null}
          {!compact ? (
            <Link
              href={goalDeepLink(goal)}
              className="rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              See these games
            </Link>
          ) : null}
        </span>
      </div>
    </div>
  );
}
