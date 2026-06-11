"use client";

import { ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/Card";
import type { LeakRow, ReportDrill } from "./types";

/**
 * Leak ledger — every leak category the agent has flagged across the
 * filtered set, priced in minerals and tied to outcomes:
 *
 *   - Cost/game and total cost (summed slim-row mineral_cost — same
 *     numbers the per-replay drilldown shows, aggregated).
 *   - Win rate WITH the leak vs WITHOUT it. "Without" means scored
 *     games where the category never reached the game's top-3 leaks,
 *     which for this scorer is equivalent to "didn't happen" — the
 *     agent emits at most one leak per category and only when it
 *     actually incurred a penalty.
 *   - Trend: leak cost per game over the newer half of the range vs
 *     the older half. Negative delta = improving.
 *
 * Rows click through to the exact games behind them (games-list
 * ``leak`` filter), where the existing per-game breakdown popover
 * takes over.
 */

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function TrendCell({ row }: { row: LeakRow }) {
  const delta = row.trend?.deltaPerGame;
  if (delta == null) {
    return <span className="text-text-dim">—</span>;
  }
  const improving = delta < 0;
  const Icon = improving ? TrendingDown : TrendingUp;
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${
        improving ? "text-success" : "text-danger"
      }`}
      title={`${row.trend?.previousPerGame ?? "—"} → ${
        row.trend?.currentPerGame ?? "—"
      } minerals/game (older half → newer half)`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {delta > 0 ? "+" : ""}
      {Math.round(delta).toLocaleString()}
    </span>
  );
}

export function LeakLedgerCard({
  leaks,
  gamesScored,
  onDrill,
}: {
  leaks: LeakRow[];
  gamesScored: number;
  onDrill: (drill: ReportDrill) => void;
}) {
  if (leaks.length === 0) {
    return (
      <Card title="Leak ledger">
        <EmptyState
          title="No leaks on record"
          sub="Either your macro is spotless or these games predate leak tracking — the header card offers a backfill."
        />
      </Card>
    );
  }

  return (
    <Card title="Leak ledger" padded={false}>
      <p className="px-4 pt-3 text-caption text-text-dim sm:px-5">
        Each leak priced across {gamesScored.toLocaleString()} scored games ·
        click a row for the games behind it.
      </p>
      <div className="overflow-x-auto p-2 sm:p-3">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-micro uppercase tracking-wider text-text-dim">
              <th className="px-2 py-2 font-medium">Leak</th>
              <th className="px-2 py-2 text-right font-medium">Games</th>
              <th className="px-2 py-2 text-right font-medium">Cost / game</th>
              <th className="px-2 py-2 text-right font-medium">Total cost</th>
              <th className="px-2 py-2 text-right font-medium">WR with</th>
              <th className="px-2 py-2 text-right font-medium">WR without</th>
              <th className="px-2 py-2 text-right font-medium">
                Trend (min/game)
              </th>
              <th className="w-6 px-2 py-2" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {leaks.map((row) => {
              const wrDelta =
                row.winRateWith != null && row.winRateWithout != null
                  ? Math.round(
                      (row.winRateWithout - row.winRateWith) * 100,
                    )
                  : null;
              return (
                <tr
                  key={row.name}
                  onClick={() =>
                    onDrill({
                      title: `Games with “${row.name}”`,
                      description: `${row.games.toLocaleString()} game${
                        row.games === 1 ? "" : "s"
                      } · ~${row.mineralsPerGame.toLocaleString()} minerals lost per game`,
                      params: { leak: row.name },
                    })
                  }
                  className="cursor-pointer border-t border-border transition-colors hover:bg-bg-elevated/60"
                >
                  <td className="px-2 py-2.5 font-medium text-text">
                    {row.name}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-text-muted">
                    {row.games.toLocaleString()}
                    <span className="text-text-dim"> ({pct(row.share)})</span>
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-text">
                    ~{row.mineralsPerGame.toLocaleString()}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-text-muted">
                    ~{row.totalMinerals.toLocaleString()}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-text-muted">
                    {pct(row.winRateWith)}
                  </td>
                  <td className="px-2 py-2.5 text-right tabular-nums">
                    <span className="text-text-muted">
                      {pct(row.winRateWithout)}
                    </span>
                    {wrDelta != null && wrDelta !== 0 ? (
                      <span
                        className={`ml-1 text-micro tabular-nums ${
                          wrDelta > 0 ? "text-success" : "text-danger"
                        }`}
                      >
                        ({wrDelta > 0 ? "+" : ""}
                        {wrDelta})
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <TrendCell row={row} />
                  </td>
                  <td className="px-2 py-2.5 text-text-dim">
                    <ChevronRight className="h-4 w-4" aria-hidden />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
