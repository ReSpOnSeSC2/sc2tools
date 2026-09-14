"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Line,
  ReferenceLine,
} from "recharts";
import { useTrendsApi as useApi } from "@/lib/trendsDataContext";
import { TrendsRequestError } from "./TrendsRequestError";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { wrColor } from "@/lib/format";
import { clientTimezone, localDateKey } from "@/lib/timeseries";
import { ChartTooltip } from "./ChartTooltip";

type MatchupPoint = {
  bucket: string;
  race: "P" | "T" | "Z" | "R" | "U";
  myRace: "P" | "T" | "Z" | "R" | "U";
  matchup: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type MatchupResponse = {
  interval: "day" | "week" | "month";
  points: MatchupPoint[];
};

type RaceKey = "P" | "T" | "Z";
const MATCHUP_ORDER = ["PvP", "PvZ", "PvT", "TvT", "TvZ", "TvP", "ZvZ", "ZvT", "ZvP"] as const;
type MatchupKey = (typeof MATCHUP_ORDER)[number];

function isPlayedMatchup(value: string): value is MatchupKey {
  return MATCHUP_ORDER.includes(value as MatchupKey);
}

type PanelPoint = {
  date: string;
  wins: number;
  losses: number;
  total: number;
  /** Period WR (0-100), or null for periods with no games. */
  winRatePct: number | null;
  /** Volume-weighted rolling WR over the last N periods (0-100). */
  rollingPct: number | null;
};

const RACE_META: Record<RaceKey, { label: string; color: string }> = {
  P: { label: "Protoss", color: "#7c8cff" },
  T: { label: "Terran", color: "#ff6b6b" },
  Z: { label: "Zerg", color: "#a78bfa" },
};

const MATCHUP_META = MATCHUP_ORDER.map((key) => ({
  key,
  description: `${RACE_META[key[0] as RaceKey].label} vs ${RACE_META[key[2] as RaceKey].label}`,
  color: RACE_META[key[2] as RaceKey].color,
}));

const ROLL_BY_BUCKET: Record<"day" | "week" | "month", number> = {
  day: 14,
  week: 4,
  month: 3,
};

/**
 * Win rate for each played race pairing, shown in separate small charts.
 *
 * Each panel shares the same X-axis (date buckets) and Y-axis (0-100%
 * win rate) so the eye can scan downward and spot which matchup is
 * collapsing or improving. A reference line at the panel's overall WR
 * makes it obvious whether a recent dip is real or just regression to
 * the mean, and a volume-weighted rolling line cuts through the spike
 * noise that daily 0%/100% buckets otherwise create.
 *
 * Bucketing follows the user's interval choice on the Trends tab so
 * the panels stay aligned with the games-per-period and rolling-WR
 * cards.
 */
export function MatchupOverTimeChart({
  bucket,
}: {
  bucket: "day" | "week" | "month";
}) {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: bucket, tz, group_by: "matchup" }),
    [filters, bucket, tz],
  );
  const { data, isLoading, error, mutate } = useApi<MatchupResponse>(
    `/v1/timeseries/matchups${filtersToQuery(params)}#${dbRev}`,
  );

  const effectiveBucket = data?.interval ?? bucket;
  const rollWindow = ROLL_BY_BUCKET[effectiveBucket];

  const seriesByMatchup = useMemo(() => {
    const out = new Map<MatchupKey, PanelPoint[]>();
    if (!data || !Array.isArray(data.points)) return out;
    const dateSet = new Set<string>();
    const byKey = new Map<string, MatchupPoint>();
    for (const p of data.points) {
      const date = localDateKey(p.bucket, tz);
      if (!date) continue;
      dateSet.add(date);
      if (isPlayedMatchup(p.matchup)) byKey.set(`${date}|${p.matchup}`, p);
    }
    const dates = Array.from(dateSet).sort();
    for (const matchup of MATCHUP_META) {
      const series: Array<Omit<PanelPoint, "rollingPct">> = [];
      for (const date of dates) {
        const p = byKey.get(`${date}|${matchup.key}`);
        if (p && p.total > 0) {
          series.push({
            date,
            wins: p.wins,
            losses: p.losses,
            total: p.total,
            winRatePct: Math.round(p.winRate * 100),
          });
        } else {
          series.push({
            date,
            wins: 0,
            losses: 0,
            total: 0,
            winRatePct: null,
          });
        }
      }
      if (series.some((p) => p.total > 0)) {
        out.set(matchup.key, withRollingWr(series, rollWindow));
      }
    }
    return out;
  }, [data, tz, rollWindow]);

  const dateRange = useMemo(() => {
    let earliest: string | null = null;
    let latest: string | null = null;
    for (const series of seriesByMatchup.values()) {
      for (const p of series) {
        if (p.total > 0) {
          if (!earliest || p.date < earliest) earliest = p.date;
          if (!latest || p.date > latest) latest = p.date;
        }
      }
    }
    return { earliest, latest };
  }, [seriesByMatchup]);

  const showYearOnTicks = useMemo(() => {
    if (!dateRange.earliest || !dateRange.latest) return false;
    // Spanning years — or ending in a past one — both need the year.
    if (dateRange.earliest.slice(0, 4) !== dateRange.latest.slice(0, 4)) {
      return true;
    }
    return dateRange.latest.slice(0, 4) !== String(new Date().getFullYear());
  }, [dateRange]);

  if (error) return <TrendsRequestError title="Win rate by matchup over time" error={error} retry={mutate} />;

  if (isLoading) {
    return (
      <Card title="Win rate by matchup over time">
        <Skeleton rows={3} />
      </Card>
    );
  }

  const totalGames = (data?.points || []).reduce(
    (acc, p) => acc + (p.total || 0),
    0,
  );
  const unassignedGames = (data?.points || []).reduce(
    (sum, p) => sum + (isPlayedMatchup(p.matchup) ? 0 : p.total || 0),
    0,
  );

  if (!data || !seriesByMatchup.size) {
    return (
      <Card title="Win rate by matchup over time">
        <EmptyState
          title={totalGames ? "Played races are not recorded" : "Not enough games yet"}
          sub={totalGames
            ? `${totalGames.toLocaleString()} selected game${totalGames === 1 ? " is" : "s are"} missing one or both concrete played races. Matchup trends need both races.`
            : "Matchup trend lines appear when the selected records include games with both played races recorded."}
        />
      </Card>
    );
  }

  const intervalLabel =
    effectiveBucket === "day" ? "daily" : effectiveBucket === "week" ? "weekly" : "monthly";

  return (
    <Card title="Win rate by matchup over time">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        One panel per played matchup, with the played race listed first. Random-queue games use the race actually played.
        The faint line is the {intervalLabel} bucket,
        bold line is the volume-weighted {rollWindow}-period rolling average ·
        dashed reference is that matchup's overall WR.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {MATCHUP_META.filter((matchup) => seriesByMatchup.has(matchup.key)).map((matchup) => (
          <MatchupPanel
            key={matchup.key}
            label={matchup.key}
            description={matchup.description}
            color={matchup.color}
            data={seriesByMatchup.get(matchup.key)!}
            showYear={showYearOnTicks}
          />
        ))}
      </div>
      {unassignedGames > 0 ? <p className="mt-3 text-micro text-text-dim">
        {unassignedGames.toLocaleString()} selected game{unassignedGames === 1 ? " is" : "s are"} missing one or both concrete played races and cannot be assigned to these matchups.
      </p> : null}
    </Card>
  );
}

function MatchupPanel({
  label,
  description,
  color,
  data,
  showYear,
}: {
  label: string;
  description: string;
  color: string;
  data: PanelPoint[];
  showYear: boolean;
}) {
  const { totalGames, totalWins, recentWr } = useMemo(() => {
    let games = 0;
    let wins = 0;
    for (const p of data) {
      games += p.total;
      wins += p.wins;
    }
    // "Recent form" = WR over the last quarter of the visible periods
    // that actually contained games. Falls back to all-time once the
    // sample is too thin to bother slicing.
    const played = data.filter((p) => p.total > 0);
    let rWins = 0;
    let rGames = 0;
    if (played.length >= 4) {
      const tail = played.slice(Math.max(0, played.length - Math.ceil(played.length / 4)));
      for (const p of tail) {
        rWins += p.wins;
        rGames += p.total;
      }
    } else {
      rWins = wins;
      rGames = games;
    }
    return {
      totalGames: games,
      totalWins: wins,
      recentWr: rGames ? rWins / rGames : null,
    };
  }, [data]);

  const overallWrPct = totalGames ? Math.round((totalWins / totalGames) * 100) : 0;
  const recentWrPct = recentWr == null ? null : Math.round(recentWr * 100);
  const trendDelta =
    recentWrPct == null ? null : recentWrPct - overallWrPct;

  return (
    <section aria-label={`${label} win rate over time`} className="min-w-0 rounded-lg border border-border bg-bg-elevated/50 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div>
          <h4 className="text-caption font-semibold text-text">{label}</h4>
          <p className="text-micro text-text-dim">{description}</p>
        </div>
        <div className="flex flex-wrap items-baseline gap-2 text-caption tabular-nums">
          {totalGames > 0 ? (
            <span style={{ color: wrColor(totalWins / totalGames, totalGames) }}>
              {overallWrPct}%
            </span>
          ) : null}
          <span className="text-text-dim">
            {totalGames > 0
              ? `${totalGames} game${totalGames === 1 ? "" : "s"}`
              : "no games"}
          </span>
          {trendDelta != null && totalGames >= 6 ? (
            <span
              className={
                trendDelta >= 3
                  ? "text-success"
                  : trendDelta <= -3
                    ? "text-danger"
                    : "text-text-dim"
              }
              title={`Recent form: ${recentWrPct}% vs ${overallWrPct}% lifetime`}
            >
              {trendDelta > 0 ? "▲" : trendDelta < 0 ? "▼" : "▬"}{" "}
              {Math.abs(trendDelta)}%
            </span>
          ) : null}
        </div>
      </div>
      <div className="h-44 sm:h-40 md:h-44">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
            <XAxis
              dataKey="date"
              stroke="#6b7280"
              fontSize={10}
              tickFormatter={(v) => formatTick(v, showYear)}
              minTickGap={36}
              tickMargin={4}
            />
            <YAxis
              stroke="#6b7280"
              fontSize={10}
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v) => `${v}%`}
              width={36}
            />
            <ReferenceLine y={50} stroke="#3a4252" strokeDasharray="2 4" />
            {totalGames > 0 ? (
              <ReferenceLine
                y={overallWrPct}
                stroke={color}
                strokeOpacity={0.5}
                strokeDasharray="6 4"
              />
            ) : null}
            <Tooltip
              content={({ active, payload, label: axisLabel }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as PanelPoint;
                const rows = [];
                if (p.winRatePct != null) {
                  rows.push({
                    key: "period",
                    label: "Win rate",
                    value: `${p.winRatePct}% · ${p.total} game${
                      p.total === 1 ? "" : "s"
                    }`,
                  });
                }
                if (p.rollingPct != null) {
                  rows.push({
                    key: "rolling",
                    label: "Rolling",
                    value: `${p.rollingPct}%`,
                  });
                }
                if (!rows.length) return null;
                return (
                  <ChartTooltip
                    header={`${label} · ${formatTick(String(axisLabel), true)}`}
                    rows={rows}
                  />
                );
              }}
            />
            <Line
              type="linear"
              dataKey="winRatePct"
              stroke={color}
              strokeOpacity={0.35}
              strokeWidth={1.25}
              dot={{ r: 1.5, strokeWidth: 0, fill: color, fillOpacity: 0.4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="rollingPct"
              stroke={color}
              strokeWidth={2.4}
              dot={false}
              connectNulls={true}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

/**
 * Volume-weighted rolling WR over the last `windowN` periods (skipping
 * empty ones for the window count). Returns the input series with a
 * `rollingPct` field added per row — null until the window is full so
 * the trace doesn't lie about precision.
 */
function withRollingWr(
  series: Array<Omit<PanelPoint, "rollingPct">>,
  windowN: number,
): PanelPoint[] {
  const out: PanelPoint[] = [];
  const queue: Array<Omit<PanelPoint, "rollingPct">> = [];
  let wins = 0;
  let games = 0;
  for (const p of series) {
    if (p.total > 0) {
      queue.push(p);
      wins += p.wins;
      games += p.total;
      if (queue.length > windowN) {
        const dropped = queue.shift()!;
        wins -= dropped.wins;
        games -= dropped.total;
      }
    }
    const ready = queue.length === windowN && games > 0;
    out.push({
      ...p,
      rollingPct: ready ? Math.round((wins / games) * 100) : null,
    });
  }
  return out;
}

/**
 * Format a `YYYY-MM-DD` bucket key for the X-axis. When the visible
 * series spans more than one calendar year, append a 2-digit year so
 * "Jan" never looks like it comes after "Dec" of the previous year.
 */
function formatTick(value: string, showYear: boolean): string {
  if (!value || value.length < 10) return value;
  const [y, m, d] = value.split("-");
  const monthIdx = Number.parseInt(m, 10) - 1;
  const dayN = Number.parseInt(d, 10);
  if (Number.isNaN(monthIdx) || monthIdx < 0 || monthIdx > 11) return value;
  const month = MONTHS[monthIdx];
  if (showYear) return `${month} '${y.slice(2)}`;
  return `${month} ${dayN}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
