"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
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

/**
 * Win-rate vs each opponent race, faceted into four small charts.
 *
 * Each panel shares the same X-axis (date buckets) and Y-axis (0-100%
 * win rate) so the eye can scan downward and spot which matchup is
 * collapsing or improving. A reference line at 50% calibrates the
 * coinflip baseline.
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

  const seriesByRace = useMemo(() => {
    /** @type {Record<RaceKey, Array<{date: string, wins: number, losses: number, total: number, winRatePct: number}>>} */
    const out: Record<
      RaceKey,
      Array<{
        date: string;
        wins: number;
        losses: number;
        total: number;
        winRatePct: number | null;
      }>
    > = { P: [], T: [], Z: [], R: [] };
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
      for (const date of dates) {
        const key = `${date}|${race.key}`;
        const p = byKey.get(key);
        if (p && p.total > 0) {
          out[race.key].push({
            date,
            wins: p.wins,
            losses: p.losses,
            total: p.total,
            winRatePct: Math.round(p.winRate * 100),
          });
        } else {
          out[race.key].push({
            date,
            wins: 0,
            losses: 0,
            total: 0,
            winRatePct: null,
          });
        }
      }
    }
    return out;
  }, [data, tz]);

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

  return (
    <Card title="Win rate by matchup over time">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        One panel per opponent race · 50% reference is the coinflip baseline
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {RACE_META.map((race) => (
          <MatchupPanel
            key={race.key}
            label={race.label}
            color={race.color}
            data={seriesByRace[race.key]}
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
}: {
  label: string;
  color: string;
  data: Array<{
    date: string;
    wins: number;
    losses: number;
    total: number;
    winRatePct: number | null;
  }>;
}) {
  const totalGames = data.reduce((acc, p) => acc + p.total, 0);
  const totalWins = data.reduce((acc, p) => acc + p.wins, 0);
  const overallWr = totalGames ? Math.round((totalWins / totalGames) * 100) : 0;

  return (
    <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-caption font-semibold text-text">{label}</span>
        <span className="text-caption tabular-nums text-text-dim">
          {totalGames > 0
            ? `${overallWr}% · ${totalGames} game${totalGames === 1 ? "" : "s"}`
            : "no games"}
        </span>
      </div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 4, right: 6, bottom: 0, left: -16 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
            <XAxis
              dataKey="date"
              stroke="#6b7280"
              fontSize={10}
              tickFormatter={shortDate}
              minTickGap={24}
            />
            <YAxis
              stroke="#6b7280"
              fontSize={10}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}`}
              width={28}
            />
            <ReferenceLine y={50} stroke="#3a4252" strokeDasharray="2 4" />
            <Tooltip
              contentStyle={{
                background: "#11141b",
                border: "1px solid #1f2533",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number | string, _key, ctx) => {
                if (value === null || value === undefined) return ["—", "WR"];
                const payload = (ctx as { payload?: { total?: number } })
                  .payload;
                const total = payload?.total ?? 0;
                return [`${value}% (${total} games)`, label];
              }}
            />
            <Line
              type="monotone"
              dataKey="winRatePct"
              stroke={color}
              strokeWidth={2}
              dot={{ r: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function shortDate(value: string): string {
  if (!value || value.length < 10) return value;
  return value.slice(5);
}
