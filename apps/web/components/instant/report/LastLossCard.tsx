"use client";

/**
 * Loss autopsy for your most recent loss — "why you lost", from
 * `report.lastLoss`, rendered by the analyzer's own `LossAutopsyCard`
 * (the same rules engine as the game page). `report.lastLoss` is null
 * when there is no loss or the rules found nothing the data supports,
 * and then this renders nothing.
 *
 * Example:
 *   <LastLossCard lastLoss={report.lastLoss} />
 */
import { LossAutopsyCard } from "@/components/analyzer/game/LossAutopsyCard";
import { formatReportDate } from "./ReportBits";
import type { LastLoss } from "@/lib/instant/report";

export interface LastLossCardProps {
  lastLoss: LastLoss | null;
}

/**
 * "vs Squirtuoz · Tourmaline LE · May 8, 2026" — only the parts the game has.
 *
 * Example:
 *   lossContext({ opponent: "Rex", map: null, date: "2026-05-08T19:08:12Z" }); // -> "vs Rex · May 8, 2026"
 */
export function lossContext(game: LastLoss["game"]): string {
  const date = game.date ? formatReportDate(game.date) : null;
  return [game.opponent ? `vs ${game.opponent}` : null, game.map ?? null, date].filter(Boolean).join(" · ");
}

/**
 * Most recent loss, explained.
 *
 * Example:
 *   <LastLossCard lastLoss={{ game, causes }} />
 */
export function LastLossCard({ lastLoss }: LastLossCardProps) {
  if (!lastLoss) return null;
  const context = lossContext(lastLoss.game);
  return (
    <div data-testid="report-last-loss" className="min-w-0 space-y-2">
      <p className="text-caption text-text-muted">
        <span className="font-semibold text-text">Your most recent loss</span>
        {context ? <span className="break-words"> · {context}</span> : null}
      </p>
      <LossAutopsyCard game={lastLoss.game} />
    </div>
  );
}
