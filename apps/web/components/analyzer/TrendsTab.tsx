"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton, Stat } from "@/components/ui/Card";
import {
  apiToPeriods,
  clientTimezone,
  type ApiTimeseriesResponse,
  type Period,
} from "@/lib/timeseries";

const LS_BUCKET = "analyzer.trends.bucket";
const LS_ROLL = "analyzer.trends.rollingOn";
const ROLL_N = 4;
const MIN_PERIOD = 3;

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

function rollingWinRate(series: Period[], windowN: number): (number | null)[] {
  const out: (number | null)[] = [];
  let wins = 0;
  let games = 0;
  const queue: Period[] = [];
  for (const p of series) {
    queue.push(p);
    wins += p.wins || 0;
    games += p.games || 0;
    if (queue.length > windowN) {
      const dropped = queue.shift()!;
      wins -= dropped.wins || 0;
      games -= dropped.games || 0;
    }
    out.push(games > 0 && queue.length === windowN ? wins / games : null);
  }
  return out;
}

function streakFromSeries(series: Period[]) {
  if (!series || series.length === 0) return { kind: null as null | "win" | "loss", count: 0 };
  let kind: null | "win" | "loss" = null;
  let count = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i];
    const w = p.wins || 0;
    const l = p.losses || 0;
    if (w === 0 && l === 0) continue;
    if (w > 0 && l === 0) {
      if (kind === null) kind = "win";
      if (kind === "win") count += w;
      else break;
    } else if (l > 0 && w === 0) {
      if (kind === null) kind = "loss";
      if (kind === "loss") count += l;
      else break;
    } else {
      break;
    }
  }
  return { kind, count };
}

function bestWorstPeriod(series: Period[], minGames: number) {
  const eligible = (series || []).filter((p) => (p.games || 0) >= minGames);
  if (eligible.length === 0) return { best: null, worst: null };
  const sorted = [...eligible].sort((a, b) => b.winRate - a.winRate);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

export function TrendsTab() {
  const { filters, dbRev } = useFilters();
  const [bucket, setBucket] = useState<string>(() => readLs(LS_BUCKET, "week"));
  const [rolling, setRolling] = useState<boolean>(() => readLs(LS_ROLL, true));
  useEffect(() => writeLs(LS_BUCKET, bucket), [bucket]);
  useEffect(() => writeLs(LS_ROLL, rolling), [rolling]);

  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: bucket, tz }),
    [filters, bucket, tz],
  );
  const { data, isLoading } = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${filtersToQuery(params)}#${dbRev}`,
  );
  const series: Period[] = useMemo(
    () => apiToPeriods(data, tz),
    [data, tz],
  );

  const enriched = useMemo(() => {
    const roll = rollingWinRate(series, ROLL_N);
    return series.map((p, i) => ({
      ...p,
      rolling: roll[i],
      winRatePct: Math.round(p.winRate * 100),
      rollingPct:
        roll[i] == null ? null : Math.round((roll[i] as number) * 100),
    }));
  }, [series]);

  const kpis = useMemo(() => {
    const totalGames = series.reduce((a, p) => a + (p.games || 0), 0);
    const totalWins = series.reduce((a, p) => a + (p.wins || 0), 0);
    const totalLoss = series.reduce((a, p) => a + (p.losses || 0), 0);
    const wr = totalGames ? totalWins / totalGames : 0;
    const streak = streakFromSeries(series);
    const { best, worst } = bestWorstPeriod(series, MIN_PERIOD);
    return {
      totalGames,
      totalWins,
      totalLoss,
      wr,
      streak,
      best,
      worst,
      bestLabel: best ? `${best.date} · ${pct1(best.winRate)}` : "—",
      worstLabel: worst ? `${worst.date} · ${pct1(worst.winRate)}` : "—",
    };
  }, [series]);

  if (isLoading) return <Skeleton rows={4} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {kpis.streak.kind && kpis.streak.count > 0 && (
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
              kpis.streak.kind === "win"
                ? "bg-success/15 text-success ring-1 ring-success/30"
                : "bg-danger/15 text-danger ring-1 ring-danger/30"
            }`}
          >
            {kpis.streak.kind === "win" ? "Winning streak" : "Losing streak"} ·{" "}
            {kpis.streak.count}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={rolling}
              onChange={(e) => setRolling(e.target.checked)}
            />
            Rolling WR ({ROLL_N})
          </label>
          <span className="text-xs uppercase tracking-wider text-text-dim">
            Bucket
          </span>
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            className="input w-auto py-1 text-sm"
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Games"
          value={kpis.totalGames}
        />
        <Stat
          label="Overall WR"
          value={pct1(kpis.wr)}
          color={wrColor(kpis.wr, kpis.totalGames)}
        />
        <Stat label="Best period" value={kpis.bestLabel} />
        <Stat label="Worst period" value={kpis.worstLabel} />
      </div>

      {series.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <Card title="Games per period (W stacked on L)">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={enriched}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
                  <XAxis dataKey="date" stroke="#6b7280" fontSize={11} />
                  <YAxis stroke="#6b7280" fontSize={11} />
                  <Tooltip
                    contentStyle={{
                      background: "#11141b",
                      border: "1px solid #1f2533",
                      borderRadius: 8,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="wins" stackId="g" fill="#3ec07a" />
                  <Bar dataKey="losses" stackId="g" fill="#ff6b6b" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card
            title={
              rolling ? `Win rate (orange = rolling ${ROLL_N})` : "Win rate"
            }
          >
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={enriched}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
                  <XAxis dataKey="date" stroke="#6b7280" fontSize={11} />
                  <YAxis
                    stroke="#6b7280"
                    fontSize={11}
                    domain={[0, 100]}
                    unit="%"
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#11141b",
                      border: "1px solid #1f2533",
                      borderRadius: 8,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="winRatePct"
                    stroke="#7c8cff"
                    strokeWidth={2}
                    dot={false}
                  />
                  {rolling && (
                    <Line
                      type="monotone"
                      dataKey="rollingPct"
                      stroke="#e6b450"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
