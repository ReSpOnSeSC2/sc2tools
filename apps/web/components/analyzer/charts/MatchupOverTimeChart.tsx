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
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { wrColor } from "@/lib/format";
import { clientTimezone, localDateKey } from "@/lib/timeseries";

type MatchupPoint = {
  bucket: string;
  race: "P" | "T" | "Z" | "R" | "U";
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type MatchupResponse = {
  interval: "day" | "week" | "month";
  points: MatchupPoint[];
};

type RaceKey = "P" | "T" | "Z" | "R";

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

const RACE_META: ReadonlyArray<{
  key: RaceKey;
  label: string;
  color: string;
}> = [
  { key: "P", label: "vs Protoss", color: "#7c8cff" },
  { key: "T", label: "vs Terran", color: "#ff6b6b" },
  { key: "Z", label: "vs Zerg", color: "#a78bfa" },
  { key: "R", label: "vs Random", color: "#9aa3b2" },
];

const ROLL_BY_BUCKET: Record<"day" | "week" | "month", number> = {
  day: 14,
  week: 4,
  month: 3,
};

/**
 * Win-rate vs each opponent race, faceted into four small charts.
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
    () => ({ ...filters, interval: bucket, tz }),
    [filters, bucket, tz],
  );
  const { data, isLoading } = useApi<MatchupResponse>(
    `/v1/timeseries/matchups${filtersToQuery(params)}#${dbRev}`,
  );

  const rollWindow = ROLL_BY_BUCKET[bucket];

  const seriesByRace = useMemo(() => {
    const out: Record<RaceKey, PanelPoint[]> = { P: [], T: [], Z: [], R: [] };
    if (!data || !Array.isArray(data.points)) return out;
    const dateSet = new Set<string>();
    const byKey = new Map<string, MatchupPoint>();
    for (const p of data.points) {
      const date = localDateKey(p.bucket, tz);
      if (!date) continue;
      dateSet.add(date);
      byKey.set(`${date}|${p.race}`, p);
    }
    const dates = Array.from(dateSet).sort();
    for (const race of RACE_META) {
      const series: Array<Omit<PanelPoint, "rollingPct">> = [];
      for (const date of dates) {
        const p = byKey.get(`${date}|${race.key}`);
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
      out[race.key] = withRollingWr(series, rollWindow);
    }
    return out;
  }, [data, tz, rollWindow]);

  const dateRange = useMemo(() => {
    let earliest: string | null = null;
    let latest: string | null = null;
    for (const race of RACE_META) {
      const series = seriesByRace[race.key];
      for (const p of series) {
        if (p.total > 0) {
          if (!earliest || p.date < earliest) earliest = p.date;
          if (!latest || p.date > latest) latest = p.date;
        }
      }
    }
    return { earliest, latest };
  }, [seriesByRace]);

  const showYearOnTicks = useMemo(() => {
    if (!dateRange.earliest || !dateRange.latest) return false;
    return dateRange.earliest.slice(0, 4) !== dateRange.latest.slice(0, 4);
  }, [dateRange]);

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

  if (!data || totalGames === 0) {
    return (
      <Card title="Win rate by matchup over time">
        <EmptyState
          title="Not enough games yet"
          sub="Once you've played a few games per matchup, the per-race trend lines will appear here."
        />
      </Card>
    );
  }

  const intervalLabel =
    bucket === "day" ? "daily" : bucket === "week" ? "weekly" : "monthly";

  return (
    <Card title="Win rate by matchup over time">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        One panel per opponent race · faint line is the {intervalLabel} bucket,
        bold line is the volume-weighted {rollWindow}-period rolling average ·
        dashed reference is that matchup's overall WR.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {RACE_META.map((race) => (
          <MatchupPanel
            key={race.key}
            label={race.label}
            color={race.color}
            data={seriesByRace[race.key]}
            showYear={showYearOnTicks}
          />
        ))}
      </div>
    </Card>
  );
}

function MatchupPanel({
  label,
  color,
  data,
  showYear,
}: {
  label: string;
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
    <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-caption font-semibold text-text">{label}</span>
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
              contentStyle={{
                background: "#11141b",
                border: "1px solid #1f2533",
                borderRadius: 8,
                fontSize: 12,
                padding: "6px 8px",
              }}
              labelFormatter={(v: string) => formatTick(v, true)}
              formatter={(value: number | string, name: string, ctx) => {
                if (value === null || value === undefined) return ["—", name];
                const payload = (ctx as { payload?: PanelPoint }).payload;
                const total = payload?.total ?? 0;
                if (name === "rollingPct")
                  return [`${value}% (rolling)`, label];
                return [`${value}% (${total} games)`, label];
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
    </div>
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
