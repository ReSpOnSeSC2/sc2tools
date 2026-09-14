"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Bar,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
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
import { ChartTooltip } from "./charts/ChartTooltip";

const LS_BUCKET = "analyzer.trends.bucket";
const LS_ROLL = "analyzer.trends.rollingOn";
const ROLL_N = 4;
const MIN_PERIOD = 3;

/**
 * Resolved colour tokens for chart fills/strokes.
 *
 * Source of truth: apps/web/app/globals.css :root[data-theme="dark"].
 * Recharts' SVG primitives (gradient stops, dot fills, cursor strokes)
 * need concrete CSS colour strings, and the design system stores tokens
 * as `--accent`/`--success`/etc. (no `--color-` prefix), so we mirror
 * the dark-theme hex values here. Keep these in sync if globals.css
 * changes.
 */
const COLOR = {
  accent: "#7c8cff", // --accent
  success: "#3ec07a", // --success
  warning: "#e6b450", // --warning
  danger: "#ff6b6b", // --danger
  border: "#1f2533", // --border
  borderStrong: "#2a3142", // --border-strong
  textDim: "#6b7280", // --text-dim
  bg: "#0b0d12", // --bg
  bgSurface: "#11141b", // --bg-surface
} as const;

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
  const { isGlobal } = useTrendsDataScope();
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
  const { data, isLoading, error, mutate } = useApi<ApiTimeseriesResponse>(
    `/v1/timeseries${filtersToQuery(params)}#${dbRev}`,
  );
  const series: Period[] = useMemo(
    () => apiToPeriods(data, tz),
    [data, tz],
  );
  const effectiveBucket = data?.interval ?? bucket;

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
  if (error) return <TrendsRequestError title="Trends" retry={mutate} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {!isGlobal && kpis.streak.kind && kpis.streak.count > 0 && (
          <span
            className={`rounded px-2 py-0.5 text-micro font-semibold tabular-nums ${
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
              className="h-4 w-4 cursor-pointer accent-accent"
            />
            Rolling WR ({ROLL_N})
          </label>
          <span className="text-xs uppercase tracking-wider text-text-dim">
            Bucket
          </span>
          <select
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            className="w-full rounded-lg border-2 border-line bg-bg-surface px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none text-sm"
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={isGlobal ? "Player game records" : "Games"}
          value={kpis.totalGames}
        />
        <Stat
          label="Overall WR"
          value={pct1(kpis.wr)}
          color={wrColor(kpis.wr, kpis.totalGames)}
        />
        <Stat label={`Best ${effectiveBucket}`} value={kpis.bestLabel} />
        <Stat label={`Worst ${effectiveBucket}`} value={kpis.worstLabel} />
      </div>

      {isGlobal && effectiveBucket !== bucket && (
        <p role="status" className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-caption text-text-muted">
          Showing {effectiveBucket === "month" ? "monthly" : effectiveBucket === "week" ? "weekly" : "daily"} periods to cover this date range. Choose a shorter range for finer detail.
        </p>
      )}

      {series.length === 0 ? (
        isGlobal ? <EmptyState title="No player game records match these filters" sub="Adjust the player selection or game filters to broaden this view." /> : <EmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card title="Games per period (W stacked on L)">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={enriched}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
                  <XAxis dataKey="date" stroke="#6b7280" fontSize={11} />
                  <YAxis stroke="#6b7280" fontSize={11} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0)
                        return null;
                      const p = payload[0].payload as {
                        wins: number;
                        losses: number;
                      };
                      return (
                        <ChartTooltip
                          header={String(label)}
                          rows={[
                            {
                              key: "wins",
                              label: "Wins",
                              value: p.wins,
                              dot: COLOR.success,
                            },
                            {
                              key: "losses",
                              label: "Losses",
                              value: p.losses,
                              dot: COLOR.danger,
                            },
                          ]}
                        />
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="wins" stackId="g" fill="#3ec07a" />
                  <Bar dataKey="losses" stackId="g" fill="#ff6b6b" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Win rate">
            {rolling && (
              <p className="text-caption text-text-dim mb-2">
                Solid = period · dashed = rolling {ROLL_N}-period average
              </p>
            )}
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={enriched}>
                  <defs>
                    <linearGradient
                      id="winRateFill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor={COLOR.accent}
                        stopOpacity={0.35}
                      />
                      <stop
                        offset="100%"
                        stopColor={COLOR.accent}
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="2 4"
                    stroke={COLOR.border}
                  />
                  <XAxis
                    dataKey="date"
                    stroke={COLOR.textDim}
                    fontSize={12}
                    tickMargin={6}
                    minTickGap={20}
                  />
                  <YAxis
                    stroke={COLOR.textDim}
                    fontSize={12}
                    domain={[0, 100]}
                    unit="%"
                    ticks={[0, 25, 50, 75, 100]}
                    tickMargin={4}
                  />
                  <Tooltip
                    cursor={{
                      stroke: COLOR.accent,
                      strokeWidth: 1,
                      strokeDasharray: "3 3",
                    }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0)
                        return null;
                      const p = payload[0].payload as {
                        winRatePct: number | null;
                        rollingPct: number | null;
                      };
                      const rows = [];
                      if (p.winRatePct != null) {
                        rows.push({
                          key: "wr",
                          label: "Win rate",
                          value: `${p.winRatePct}%`,
                          dot: COLOR.accent,
                        });
                      }
                      if (p.rollingPct != null) {
                        rows.push({
                          key: "rolling",
                          label: `Rolling WR (${ROLL_N})`,
                          value: `${p.rollingPct}%`,
                          dot: COLOR.warning,
                        });
                      }
                      if (!rows.length) return null;
                      return <ChartTooltip header={String(label)} rows={rows} />;
                    }}
                  />
                  <ReferenceLine
                    y={50}
                    stroke={COLOR.borderStrong}
                    strokeDasharray="2 4"
                    strokeWidth={1}
                    label={{
                      value: "50%",
                      position: "right",
                      fill: COLOR.textDim,
                      fontSize: 10,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="winRatePct"
                    stroke="none"
                    fill="url(#winRateFill)"
                    isAnimationActive={false}
                    legendType="none"
                    tooltipType="none"
                  />
                  <Line
                    type="monotone"
                    dataKey="winRatePct"
                    stroke={COLOR.accent}
                    strokeWidth={2.5}
                    dot={{ r: 3, strokeWidth: 0, fill: COLOR.accent }}
                    activeDot={{
                      r: 5,
                      strokeWidth: 2,
                      stroke: COLOR.bg,
                      fill: COLOR.accent,
                    }}
                    isAnimationActive={false}
                  />
                  {rolling && (
                    <Line
                      type="monotone"
                      dataKey="rollingPct"
                      stroke={COLOR.warning}
                      strokeWidth={2}
                      strokeDasharray="5 3"
                      dot={{ r: 2.5, strokeWidth: 0, fill: COLOR.warning }}
                      activeDot={{
                        r: 4,
                        strokeWidth: 2,
                        stroke: COLOR.bg,
                        fill: COLOR.warning,
                      }}
                      isAnimationActive={false}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>

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
      )}

      {/* The identity artifact closes the tab, immediately after map trends. */}
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
