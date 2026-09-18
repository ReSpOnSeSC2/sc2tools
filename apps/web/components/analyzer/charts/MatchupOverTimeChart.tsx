"use client";

import { useMemo } from "react";
import { useTrendsApi as useApi, useTrendsDataScope } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone, localDateKey } from "@/lib/timeseries";
import { buildWinRateTrend, type WinRatePeriod } from "@/lib/winRateTrend";
import { WinRateSampleSummary, WinRateTrendPlot } from "./WinRateTrendPlot";

type MatchupPoint = { bucket: string; matchup: string; wins: number; losses: number; total: number };
type MatchupResponse = { interval: "day" | "week" | "month"; points: MatchupPoint[] };
const MATCHUP_ORDER = ["PvP", "PvZ", "PvT", "TvT", "TvZ", "TvP", "ZvZ", "ZvT", "ZvP"] as const;
type MatchupKey = (typeof MATCHUP_ORDER)[number];
const RACE_NAMES: Record<string, string> = { P: "Protoss", T: "Terran", Z: "Zerg" };
const TARGET_GAMES = 20;
const isPlayedMatchup = (value: string): value is MatchupKey => MATCHUP_ORDER.includes(value as MatchupKey);

/** Same game-sample target and time scale make sparse matchup panels comparable. */
export function MatchupOverTimeChart(_props: { bucket: "day" | "week" | "month" }) {
  const { filters, dbRev } = useFilters();
  const { isGlobal } = useTrendsDataScope();
  const recordLabel = isGlobal ? "player game records" : "games";
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(() => ({ ...filters, interval: "day", tz, group_by: "matchup" }), [filters, tz]);
  const { data, isLoading, error, mutate } = useApi<MatchupResponse>(`/v1/timeseries/matchups${filtersToQuery(params)}#${dbRev}`);
  const { panels, dateDomain } = useMemo(() => {
    const byMatchup = new Map<MatchupKey, WinRatePeriod[]>();
    const dates: string[] = [];
    for (const point of data?.points ?? []) {
      const date = localDateKey(point.bucket, tz);
      if (!date || !isPlayedMatchup(point.matchup) || point.total <= 0) continue;
      dates.push(date);
      const periods = byMatchup.get(point.matchup) ?? [];
      periods.push({ date, games: point.total, wins: point.wins, losses: point.losses });
      byMatchup.set(point.matchup, periods);
    }
    dates.sort();
    return {
      panels: MATCHUP_ORDER.filter((key) => byMatchup.has(key)).map((key) => ({ key, trend: buildWinRateTrend(byMatchup.get(key)!, TARGET_GAMES) })),
      dateDomain: dates.length ? [dates[0], dates[dates.length - 1]] as [string, string] : undefined,
    };
  }, [data, tz]);

  if (error) return <TrendsRequestError title="Win rate by matchup over time" error={error} retry={mutate} />;
  if (isLoading) return <Card title="Win rate by matchup over time"><Skeleton rows={3} /></Card>;
  const totalGames = (data?.points ?? []).reduce((sum, point) => sum + (point.total || 0), 0);
  const unassignedGames = (data?.points ?? []).reduce((sum, point) => sum + (isPlayedMatchup(point.matchup) ? 0 : point.total || 0), 0);
  if (!panels.length) return (
    <Card title="Win rate by matchup over time">
      <EmptyState title={totalGames ? "Played races are not recorded" : "Not enough games yet"} sub={totalGames
        ? `${totalGames.toLocaleString()} selected ${recordLabel} are missing one or both concrete played races. Matchup trends need both races.`
        : "Matchup trend lines appear when the selected records include games with both played races recorded."} />
    </Card>
  );
  const interval = data?.interval ?? "day";
  const periods = interval === "week" ? "weeks" : interval === "month" ? "months" : "days";
  return (
    <Card title="Win rate by matchup over time" className="min-w-0">
      <p className="mb-4 text-caption leading-relaxed text-text-muted">
        Recent form from at least {TARGET_GAMES} {recordLabel} per matchup. The played race is listed first; Random-queue games use the race actually played.
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {panels.map(({ key, trend }) => (
          <section key={key} aria-label={`${key} win rate over time`} className="min-w-0 rounded-xl border border-border bg-bg-elevated/40 p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h4 className="text-caption font-semibold text-text">{key}</h4>
                <p className="text-micro text-text-muted">{RACE_NAMES[key[0]]} vs {RACE_NAMES[key[2]]}</p>
              </div>
              <div className="text-right text-micro tabular-nums text-text-muted">
                <div>{trend.overall.games.toLocaleString()} {isGlobal ? "records" : trend.overall.games === 1 ? "game" : "games"}</div>
                {!trend.readyPoints && <div>Overall {trend.overall.rate?.toFixed(1)}%</div>}
              </div>
            </div>
            <WinRateSampleSummary compact trend={trend} targetGames={TARGET_GAMES} recordLabel={recordLabel} interval={interval} />
            <WinRateTrendPlot compact trend={trend} label={`${key} recent form`} dateDomain={dateDomain} recordLabel={recordLabel} interval={interval} />
          </section>
        ))}
      </div>
      <p className="mt-4 text-micro leading-relaxed text-text-muted">
        All panels share the same dates and 0–100% scale. Samples keep whole {periods}, so counts can exceed {TARGET_GAMES}. The dashed line is each matchup’s overall rate in this range.
        {isGlobal ? " Results combine the selected players." : ""}
      </p>
      {unassignedGames > 0 && <p className="mt-2 text-micro text-text-muted">{unassignedGames.toLocaleString()} selected {recordLabel} are missing one or both concrete played races and cannot be assigned to these matchups.</p>}
    </Card>
  );
}
