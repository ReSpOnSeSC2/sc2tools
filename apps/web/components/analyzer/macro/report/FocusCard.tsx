"use client";

import { Crosshair, TrendingDown, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { LeakRow, MacroReportData } from "./types";

/**
 * "Fix this first" — the single highest-EV improvement in the
 * filtered set: the leak category with the largest total mineral
 * cost. Everything shown is derived from real aggregates (cost per
 * game, frequency, win-rate delta, current-vs-previous-half trend);
 * the only authored content is the per-category drill tip.
 */

const TIPS: Record<string, string> = {
  "Supply Blocked":
    "Start the next supply structure before you hit the cap — tie it to a habit, e.g. every time you tab back to your base.",
  "Mineral Float":
    "When the bank passes ~800 minerals after 4:00, add a production structure or take an expansion instead of saving.",
  "Chrono Efficiency":
    "Spend Chrono Boost as it becomes available — idle Nexus energy is a worker or warp-cycle you never get back.",
  "Inject Efficiency":
    "Cycle your queens on a timer (camera hotkey + backspace works) — missed injects compound into a permanent larva deficit.",
  "MULE Efficiency":
    "Call down MULEs the moment Orbital energy allows; banking energy only pays off if you're saving scans on purpose.",
};

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function TrendNote({ leak }: { leak: LeakRow }) {
  const delta = leak.trend?.deltaPerGame;
  if (delta == null) return null;
  const improving = delta < 0;
  const Icon = improving ? TrendingDown : TrendingUp;
  return (
    <span
      className={`inline-flex items-center gap-1 text-caption ${
        improving ? "text-success" : "text-danger"
      }`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {improving ? "improving" : "getting worse"} ·{" "}
      {Math.abs(Math.round(delta)).toLocaleString()} min/game vs the older
      half of this range
    </span>
  );
}

export function FocusCard({ report }: { report: MacroReportData }) {
  const leak = report.leaks[0];
  if (!leak) return null;

  const wrDelta =
    leak.winRateWith != null && leak.winRateWithout != null
      ? Math.round((leak.winRateWithout - leak.winRateWith) * 100)
      : null;
  const tip = TIPS[leak.name];

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-line bg-bg-elevated">
          <Crosshair className="h-6 w-6 text-warning" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="text-micro uppercase tracking-wider text-text-dim">
            Fix this first
          </div>
          <div className="text-lg font-bold text-text">{leak.name}</div>
          <p className="mt-1 text-sm text-text-muted">
            Appears in {pct(leak.share)} of your scored games and costs you
            about{" "}
            <span className="font-semibold tabular-nums text-text">
              {leak.mineralsPerGame.toLocaleString()} minerals
            </span>{" "}
            per affected game
            {wrDelta != null && wrDelta > 0 ? (
              <>
                {" "}
                — you win {pct(leak.winRateWithout)} without it vs{" "}
                {pct(leak.winRateWith)} with it ({wrDelta} point
                {wrDelta === 1 ? "" : "s"} of win rate on the table)
              </>
            ) : null}
            .
          </p>
          {tip ? (
            <p className="mt-1.5 text-caption text-text-dim">{tip}</p>
          ) : null}
          <div className="mt-1.5">
            <TrendNote leak={leak} />
          </div>
          {report.trend &&
          report.trend.currentAvgScore != null &&
          report.trend.previousAvgScore != null ? (
            <p className="mt-1.5 text-micro text-text-dim">
              Overall macro score: {report.trend.currentAvgScore} over your
              last {report.trend.currentGames.toLocaleString()} scored games,
              vs {report.trend.previousAvgScore} over the{" "}
              {report.trend.previousGames.toLocaleString()} before that.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
