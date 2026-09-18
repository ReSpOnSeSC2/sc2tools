"use client";

import { useEffect, useMemo, useState } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./charts/TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, Stat } from "@/components/ui/Card";
import {
  apiToPeriods,
  clientTimezone,
  type ApiTimeseriesResponse,
  type Period,
} from "@/lib/timeseries";
import { FingerprintCard } from "./FingerprintCard";
import { MatchupOverTimeChart } from "./charts/MatchupOverTimeChart";
import { MatchupGameLengthCard } from "./charts/MatchupGameLengthCard";
import { TimeOfDayHeatmap } from "./charts/TimeOfDayHeatmap";
import { GameLengthWrChart } from "./charts/GameLengthWrChart";
import { ActivityCalendarChart } from "./charts/ActivityCalendarChart";
import { MmrProgressionChart } from "./charts/MmrProgressionChart";
import { MomentumChart } from "./charts/MomentumChart";
import { OppMmrBucketsChart } from "./charts/OppMmrBucketsChart";
import { MapTrendChart } from "./charts/MapTrendChart";
import { NetMmrByMatchupChart } from "./charts/NetMmrByMatchupChart";
import { ActivityVolumeChart } from "./charts/ActivityVolumeChart";
import { WinRateTrendCard } from "./charts/WinRateTrendCard";
import { DeferredTrendsExplorer } from "./explorer/DeferredTrendsExplorer";

const LS_BUCKET = "analyzer.trends.bucket";
function readLs<T>(key: string, fb: T): T {
  if (typeof window === "undefined") return fb;
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fb : (JSON.parse(v) as T);
  } catch {
    return fb;
  }
}

function writeLs(key: string, v: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* non-fatal */
  }
}

export function TrendsTab() {
  const { isGlobal } = useTrendsDataScope();
  const { filters, dbRev } = useFilters();
  const [bucket, setBucket] = useState<"day" | "week" | "month">(() => {
    const stored = readLs<string>(LS_BUCKET, "week");
    return stored === "day" || stored === "month" ? stored : "week";
  });
  useEffect(() => writeLs(LS_BUCKET, bucket), [bucket]);

  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: bucket, tz }),
    [filters, bucket, tz],
  );
  const { data, isLoading, error, mutate } = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${filtersToQuery(params)}#${dbRev}`,
  );
  const series: Period[] = useMemo(
    () => apiToPeriods(data, tz),
    [data, tz],
  );
  const effectiveBucket = data?.interval ?? bucket;

  const kpis = useMemo(() => {
    const totalGames = series.reduce((a, p) => a + (p.games || 0), 0);
    const totalWins = series.reduce((a, p) => a + (p.wins || 0), 0);
    const totalLoss = series.reduce((a, p) => a + (p.losses || 0), 0);
    const wr = totalGames ? totalWins / totalGames : 0;
    return {
      totalGames,
      totalWins,
      totalLoss,
      wr,
      activePeriods: series.filter((period) => period.games > 0).length,
    };
  }, [series]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="ml-auto flex items-center gap-3">
          <label htmlFor="trends-period" className="text-xs text-text-muted">Activity grouping</label>
          <select
            id="trends-period"
            value={bucket}
            onChange={(e) => setBucket(e.target.value as "day" | "week" | "month")}
            className="w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none text-sm"
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
      </div>

      {!isLoading && !error && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={isGlobal ? "Player game records" : "Games"}
          value={kpis.totalGames}
        />
        <Stat
          label="Overall WR"
          value={kpis.totalGames > 0 ? pct1(kpis.wr) : "—"}
          color={wrColor(kpis.wr, kpis.totalGames)}
        />
        <Stat label="Recorded results" value={`${kpis.totalWins.toLocaleString()}W · ${kpis.totalLoss.toLocaleString()}L`} />
        <Stat label={`Active ${effectiveBucket}s`} value={kpis.activePeriods} />
      </div>}

      {isGlobal && !isLoading && !error && effectiveBucket !== bucket && (
        <p role="status" className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-caption text-text-muted">
          Showing {effectiveBucket === "month" ? "monthly" : effectiveBucket === "week" ? "weekly" : "daily"} periods to cover this date range. Choose a shorter range for finer detail.
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          {isLoading || error || series.length === 0 ? (
            ["Games played"].map((title) => error ? (
              <TrendsRequestError key={title} title={title} error={error} retry={mutate} />
            ) : (
              <Card key={title} title={title}>
                {isLoading ? <div role="status" aria-label={`Loading ${title}`}><Skeleton rows={4} /></div>
                  : <EmptyState
                      title={isGlobal ? "No player game records match these filters" : "No games match these filters"}
                      sub={isGlobal ? "Adjust the player selection or game filters to broaden this view." : "Adjust the game filters or upload more games to broaden this view."}
                    />}
              </Card>
            ))
          ) : <ActivityVolumeChart periods={series} interval={effectiveBucket} isGlobal={isGlobal} />}
          <WinRateTrendCard />

          {/*
           * Keep the outcome and rating views together directly beneath the
           * headline win-rate chart. MMR progression also contains the Daily
           * MMR Records panel, so this ordering reads from rating trajectory
           * into matchup gains, opponent-MMR performance, and momentum.
           */}
          <SectionDivider
            title="Performance & MMR"
            subtitle="Rating progress, matchup gains, opponent strength, and recent form."
          />
          <div className="md:col-span-2">
            <MmrProgressionChart bucket={bucket as "day" | "week" | "month"} />
          </div>
          <NetMmrByMatchupChart />
          <OppMmrBucketsChart />
          <div className="md:col-span-2">
            <MomentumChart />
          </div>

          {/*
           * Time, duration, and activity views follow the performance block.
           * Full-width charts get room for small multiples on desktop while
           * every card still reflows into one column on mobile.
           */}
          <SectionDivider
            title="Time & activity"
            subtitle={isGlobal ? "When players play, how long games run, and how activity changes over time." : "When you play, how long games run, and how activity changes over time."}
          />
          <div className="md:col-span-2">
            <MatchupOverTimeChart bucket={bucket as "day" | "week" | "month"} />
          </div>
          <div className="md:col-span-2">
            <MatchupGameLengthCard />
          </div>
          <TimeOfDayHeatmap />
          <GameLengthWrChart />
          <div className="md:col-span-2">
            <ActivityCalendarChart />
          </div>
          <div className="md:col-span-2">
            <MapTrendChart bucket={bucket as "day" | "week" | "month"} />
          </div>
      </div>

      <DeferredTrendsExplorer />

      {/* The identity artifact closes the personal tab after the explorer. */}
      {!isGlobal && <FingerprintCard />}
    </div>
  );
}

/**
 * Subtle break between related chart groups. Spans both grid columns on
 * desktop and reflows on mobile.
 */
function SectionDivider({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mt-1 md:col-span-2">
      <div className="flex items-baseline gap-3 border-t border-border pt-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-text">
          {title}
        </h2>
        {subtitle ? (
          <span className="text-caption text-text-dim">{subtitle}</span>
        ) : null}
      </div>
    </div>
  );
}
