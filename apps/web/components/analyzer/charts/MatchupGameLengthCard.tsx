"use client";

import { useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import {
  fmtMinutes,
  fmtPlaytime,
  pct,
  PLAYTIME_FORMAT_OPTIONS,
  raceColour,
  type PlaytimeFormat,
} from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";

type RaceLetter = "P" | "T" | "Z" | "R" | "U";

type MatchupLength = {
  matchup: string;
  myRace: RaceLetter;
  opponentRace: RaceLetter;
  games: number;
  wins: number;
  losses: number;
  totalSec: number | null;
  avgSec: number | null;
  medianSec: number | null;
  avgWinSec: number | null;
  avgLossSec: number | null;
  longGameRate: number;
};

type LengthInsightsResponse = {
  summary?: {
    games: number;
    totalSec: number | null;
    avgSec: number | null;
    medianSec: number | null;
    longGameRate: number;
  };
  matchups?: MatchupLength[];
};

const LS_PLAYTIME_FORMAT = "analyzer.trends.playtimeFormat";
const DEFAULT_PLAYTIME_FORMAT: PlaytimeFormat = "hoursMinutes";

function readPlaytimeFormat(): PlaytimeFormat {
  if (typeof window === "undefined") return DEFAULT_PLAYTIME_FORMAT;
  try {
    const saved = window.localStorage.getItem(LS_PLAYTIME_FORMAT);
    return PLAYTIME_FORMAT_OPTIONS.some((option) => option.value === saved)
      ? (saved as PlaytimeFormat)
      : DEFAULT_PLAYTIME_FORMAT;
  } catch {
    return DEFAULT_PLAYTIME_FORMAT;
  }
}

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
  const [timeFormat, setTimeFormat] = useState<PlaytimeFormat>(
    DEFAULT_PLAYTIME_FORMAT,
  );
  const { data, isLoading } = useApi<LengthInsightsResponse>(
    `/v1/length-buckets${filtersToQuery(filters)}#${dbRev}`,
  );

  useEffect(() => {
    setTimeFormat(readPlaytimeFormat());
  }, []);

  function updateTimeFormat(nextFormat: PlaytimeFormat) {
    setTimeFormat(nextFormat);
    try {
      window.localStorage.setItem(LS_PLAYTIME_FORMAT, nextFormat);
    } catch {
      /* Display preference persistence is non-essential. */
    }
  }

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
      <Card title="Time played by matchup">
        <Skeleton rows={3} />
      </Card>
    );
  }

  const summary = data?.summary;
  if (!summary?.games && rows.length === 0) {
    return (
      <Card title="Time played by matchup">
        <EmptyState
          title="No game-length data in this view"
          sub="Matchup durations will appear when the selected filters include replays with a recorded game length."
        />
      </Card>
    );
  }

  const longestAverage = Math.max(...rows.map((row) => row.avgSec || 0), 1);

  return (
    <Card
      title="Time played by matchup"
      right={
        summary?.games ? (
          <span className="text-micro tabular-nums text-text-dim">
            {summary.games} measured game{summary.games === 1 ? "" : "s"}
          </span>
        ) : null
      }
    >
      <div className="-mt-1 mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <p className="text-caption text-text-dim sm:max-w-2xl">
          Totals, averages, and medians use recorded replay time from the
          filters above. 15m+ shows how often a matchup reaches the late game.
        </p>
        <label className="flex w-full shrink-0 items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <span className="text-micro uppercase tracking-wider text-text-dim">
            Display time as
          </span>
          <span className="w-40 sm:w-44">
            <Select
              selectSize="sm"
              aria-label="Time format"
              value={timeFormat}
              onChange={(event) =>
                updateTimeFormat(event.target.value as PlaytimeFormat)
              }
            >
              {PLAYTIME_FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </span>
        </label>
      </div>

      {summary ? (
        <dl className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-border bg-bg-elevated/40 p-2.5 sm:grid-cols-4">
          <SummaryMetric
            label="Total played"
            value={fmtPlaytime(summary.totalSec, timeFormat)}
          />
          <SummaryMetric label="Average" value={fmtMinutes(summary.avgSec)} />
          <SummaryMetric label="Median" value={fmtMinutes(summary.medianSec)} />
          <SummaryMetric label="Games 15m+" value={pct(summary.longGameRate)} />
        </dl>
      ) : null}

      {rows.length > 0 ? (
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
                  <PlaytimeMetric
                    value={fmtPlaytime(row.totalSec, timeFormat)}
                  />
                  <CompactMetric
                    label="Median"
                    value={fmtMinutes(row.medianSec)}
                  />
                  <CompactMetric label="15m+" value={pct(row.longGameRate)} />
                  <CompactMetric
                    label={`Wins · ${row.wins}`}
                    value={fmtMinutes(row.avgWinSec)}
                    valueClass={
                      row.avgWinSec == null
                        ? "text-text-dim"
                        : "text-success"
                    }
                  />
                  <CompactMetric
                    label={`Losses · ${row.losses}`}
                    value={fmtMinutes(row.avgLossSec)}
                    valueClass={
                      row.avgLossSec == null ? "text-text-dim" : "text-danger"
                    }
                  />
                </dl>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center">
          <p className="text-sm font-medium text-text-muted">
            No matchup breakdown for this view
          </p>
          <p className="mt-1 text-xs text-text-dim">
            The recorded time is included above, but these replays do not have
            both races needed to form a matchup.
          </p>
        </div>
      )}
    </Card>
  );
}

function PlaytimeMetric({ value }: { value: string }) {
  return (
    <div className="col-span-2 flex min-w-0 items-end justify-between gap-3 border-b border-border pb-2">
      <dt className="text-micro uppercase tracking-wider text-text-dim">
        Time played
      </dt>
      <dd className="text-right font-display text-base font-bold tabular-nums text-text">
        {value}
      </dd>
    </div>
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
