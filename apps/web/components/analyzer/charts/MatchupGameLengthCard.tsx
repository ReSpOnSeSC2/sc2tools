"use client";

import { useMemo } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { fmtMinutes, pct, raceColour } from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";

type RaceLetter = "P" | "T" | "Z" | "R" | "U";

type MatchupLength = {
  matchup: string;
  myRace: RaceLetter;
  opponentRace: RaceLetter;
  games: number;
  wins: number;
  losses: number;
  avgSec: number | null;
  medianSec: number | null;
  avgWinSec: number | null;
  avgLossSec: number | null;
  longGameRate: number;
};

type LengthInsightsResponse = {
  summary?: {
    games: number;
    avgSec: number | null;
    medianSec: number | null;
    longGameRate: number;
  };
  matchups?: MatchupLength[];
};

const RACE_ORDER: Record<RaceLetter, number> = {
  P: 0,
  T: 1,
  Z: 2,
  R: 3,
  U: 4,
};

/**
 * Filter-aware game-length summary split by the races on both sides.
 *
 * The endpoint is shared with the existing length-bucket chart, so SWR
 * deduplicates the request while the API computes both views in one facet.
 * Only matchups backed by positive replay durations are rendered.
 */
export function MatchupGameLengthCard() {
  const { filters, dbRev } = useFilters();
  const { data, isLoading } = useApi<LengthInsightsResponse>(
    `/v1/length-buckets${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(
    () =>
      (data?.matchups || [])
        .filter(
          (row) =>
            row.games > 0 &&
            typeof row.avgSec === "number" &&
            Number.isFinite(row.avgSec) &&
            row.avgSec > 0,
        )
        .sort(
          (a, b) =>
            (RACE_ORDER[a.myRace] ?? 99) - (RACE_ORDER[b.myRace] ?? 99) ||
            (RACE_ORDER[a.opponentRace] ?? 99) -
              (RACE_ORDER[b.opponentRace] ?? 99),
        ),
    [data],
  );

  if (isLoading) {
    return (
      <Card title="Game length by matchup">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card title="Game length by matchup">
        <EmptyState
          title="No game-length data in this view"
          sub="Matchup durations will appear when the selected filters include replays with a recorded game length."
        />
      </Card>
    );
  }

  const summary = data?.summary;
  const longestAverage = Math.max(...rows.map((row) => row.avgSec || 0), 1);

  return (
    <Card
      title="Game length by matchup"
      right={
        summary?.games ? (
          <span className="text-micro tabular-nums text-text-dim">
            {summary.games} measured game{summary.games === 1 ? "" : "s"}
          </span>
        ) : null
      }
    >
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Average and median use recorded replay time · 15m+ shows how often
        that matchup reaches the late game.
      </p>

      {summary ? (
        <dl className="mb-3 grid grid-cols-3 gap-2 rounded-lg border border-border bg-bg-elevated/40 p-2.5">
          <SummaryMetric label="Average" value={fmtMinutes(summary.avgSec)} />
          <SummaryMetric label="Median" value={fmtMinutes(summary.medianSec)} />
          <SummaryMetric label="Games 15m+" value={pct(summary.longGameRate)} />
        </dl>
      ) : null}

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => {
          const color = raceColour(row.opponentRace);
          const width = Math.max(
            4,
            Math.round(((row.avgSec || 0) / longestAverage) * 100),
          );
          return (
            <li
              key={`${row.myRace}-${row.opponentRace}`}
              className="rounded-lg border border-border bg-bg-elevated/50 p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="font-display text-base font-bold text-text">
                  {displayMatchup(row)}
                </h4>
                <span className="text-micro tabular-nums text-text-dim">
                  {row.games} game{row.games === 1 ? "" : "s"}
                </span>
              </div>

              <div className="mt-2 flex items-end justify-between gap-3">
                <span className="text-micro uppercase tracking-wider text-text-dim">
                  Average
                </span>
                <span className="font-display text-xl font-bold tabular-nums text-text">
                  {fmtMinutes(row.avgSec)}
                </span>
              </div>
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-surface"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${width}%`, backgroundColor: color }}
                />
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-2.5">
                <CompactMetric label="Median" value={fmtMinutes(row.medianSec)} />
                <CompactMetric label="15m+" value={pct(row.longGameRate)} />
                <CompactMetric
                  label={`Wins · ${row.wins}`}
                  value={fmtMinutes(row.avgWinSec)}
                  valueClass={row.avgWinSec == null ? "text-text-dim" : "text-success"}
                />
                <CompactMetric
                  label={`Losses · ${row.losses}`}
                  value={fmtMinutes(row.avgLossSec)}
                  valueClass={row.avgLossSec == null ? "text-text-dim" : "text-danger"}
                />
              </dl>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 text-center">
      <dt className="truncate text-micro uppercase tracking-wider text-text-dim">
        {label}
      </dt>
      <dd className="mt-0.5 font-display text-base font-bold tabular-nums text-text">
        {value}
      </dd>
    </div>
  );
}

function CompactMetric({
  label,
  value,
  valueClass = "text-text",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-micro text-text-dim">{label}</dt>
      <dd
        className={`mt-0.5 text-sm font-semibold tabular-nums ${valueClass}`}
      >
        {value}
      </dd>
    </div>
  );
}

function displayMatchup(row: MatchupLength): string {
  const mine = row.myRace === "U" ? "?" : row.myRace;
  const theirs = row.opponentRace === "U" ? "?" : row.opponentRace;
  return `${mine}v${theirs}`;
}
