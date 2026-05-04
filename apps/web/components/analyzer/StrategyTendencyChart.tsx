"use client";

import { EmptyState } from "@/components/ui/Card";
import { wrColor, pct1 } from "@/lib/format";

export type StrategyEntry = {
  strategy: string;
  wins: number;
  losses: number;
  count: number;
  winRate: number;
};

/**
 * Horizontal-bar chart showing a recurring opponent's top builds.
 * Bar fill is proportional to share of total games; the trailing
 * pill carries the matchup-coloured win-rate when the user faced it.
 *
 * Mirrors the legacy SPA `StrategyTendencyChart` consumed by
 * `OpponentProfile` — keeps the same visual hierarchy (label, ratio
 * bar, win-rate pill) without pulling in Recharts.
 */
export function StrategyTendencyChart({
  strategies,
}: {
  strategies?: StrategyEntry[];
}) {
  if (!strategies || strategies.length === 0) {
    return <EmptyState sub="No strategy data yet" />;
  }
  const total = strategies.reduce((s, x) => s + (x.count || 0), 0) || 1;
  return (
    <ul className="space-y-2">
      {strategies.map((s) => {
        const share = (100 * (s.count || 0)) / total;
        const colour = wrColor(s.winRate, s.wins + s.losses);
        return (
          <li
            key={s.strategy}
            className="flex items-center gap-3 text-sm"
            data-testid="strategy-tendency-row"
          >
            <span
              className="w-32 shrink-0 truncate text-text-muted"
              title={s.strategy}
            >
              {s.strategy}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-elevated">
              <div
                className="h-full"
                style={{ width: `${share.toFixed(1)}%`, background: colour }}
              />
            </div>
            <span
              className="w-14 text-right tabular-nums text-text-dim"
              title={`${s.wins}W ${s.losses}L`}
            >
              {s.wins}–{s.losses}
            </span>
            <span
              className="w-14 text-right tabular-nums"
              style={{ color: colour }}
              title={`win rate when this opponent went ${s.strategy}`}
            >
              {pct1(s.winRate)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
