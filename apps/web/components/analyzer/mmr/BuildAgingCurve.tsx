"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";

interface CurvePoint {
  n: number;
  wins: number;
  losses: number;
  cumulativeWins: number;
  cumulativeLosses: number;
}

interface BuildSeries {
  build: string;
  curve: CurvePoint[];
}

const LS_MIN_GAMES = "analyzer.mmr.aging.minGames";
const LS_TOP_N = "analyzer.mmr.aging.topN";

/**
 * Build-aging curve — cumulative win rate as a function of the Nth
 * time the streamer played each build. The shape of the line
 * answers "have I mastered this build" without MMR being in the
 * picture:
 *
 *   * Sharp early dip → expected first-N-games learning trough.
 *   * Smooth climb past ~10 games → the build is settling in.
 *   * Plateau at 50%+ → mastered.
 *   * Decay over many games → meta is adapting.
 *
 * Plotted as cumulative WR (not rolling) so noise smooths out
 * automatically as N grows — the early game-1-Win producing a 100%
 * WR isn't a stable signal and would dominate any rolling-window
 * smoother.
 */
export function BuildAgingCurve() {
  const { filters, dbRev } = useFilters();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_GAMES, 10);
  const [topN, setTopN] = useLocalStoragePositiveInt(LS_TOP_N, 6);

  const { data, isLoading } = useApi<BuildSeries[]>(
    `/v1/mmr-stats/aging-curve${filtersToQuery(filters)}#${dbRev}`,
  );

  const { chartData, seriesList, totalPoints } = useMemo(
    () => shapeAgingForChart(data || [], minGames, topN),
    [data, minGames, topN],
  );

  return (
    <Card title="Build mastery curve">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Cumulative win rate by the Nth time you played each build · X-axis is
        the count, not the date · Builds with fewer than ``min games`` total
        plays are hidden so single-attempt anomalies don't dominate the chart.
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">
            Min plays per build
          </span>
          <MinGamesPicker value={minGames} onChange={setMinGames} hideLabel />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-dim">
            Builds shown (top N by volume)
          </span>
          <MinGamesPicker
            value={topN}
            onChange={setTopN}
            steps={[3, 6, 10, 20]}
            hideLabel
          />
        </div>
      </div>

      <div className="mt-4" style={{ height: 280 }}>
        {isLoading ? (
          <Skeleton rows={4} />
        ) : totalPoints === 0 ? (
          <EmptyState
            title="No builds with enough plays yet"
            sub="Curves appear once a build has been played at least the configured min-plays count above."
          />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 12, left: -8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
              <XAxis
                dataKey="n"
                stroke="#6b7280"
                fontSize={10}
                tickMargin={6}
                label={{
                  value: "Nth play",
                  position: "insideBottom",
                  offset: -6,
                  style: { fill: "#6b7280", fontSize: 10 },
                }}
              />
              <YAxis
                stroke="#6b7280"
                fontSize={11}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
              />
              <ReferenceLine
                y={50}
                stroke="#3a4252"
                strokeDasharray="2 4"
              />
              <Tooltip
                contentStyle={{
                  background: "#11141b",
                  border: "1px solid #1f2533",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => [
                  `${value}%`,
                  name,
                ]}
                labelFormatter={(n) => `After ${n} plays`}
              />
              <Legend
                verticalAlign="bottom"
                height={28}
                wrapperStyle={{ fontSize: 11 }}
                formatter={(name: string) => (
                  <span className="text-text-muted">{name}</span>
                )}
              />
              {seriesList.map((s) => (
                <Line
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

const PALETTE = [
  "#7c8cff",
  "#a78bfa",
  "#3ec07a",
  "#ff6b6b",
  "#f59e0b",
  "#06b6d4",
  "#e879f9",
  "#84cc16",
  "#fb7185",
  "#22d3ee",
  "#fbbf24",
  "#a3e635",
];

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

interface ChartRow {
  n: number;
  [series: string]: number | null;
}

function shapeAgingForChart(
  series: BuildSeries[],
  minPlays: number,
  topN: number,
): {
  chartData: ChartRow[];
  seriesList: Array<{ name: string; color: string }>;
  totalPoints: number;
} {
  const qualified = series
    .filter((s) => s.curve.length >= minPlays)
    .sort((a, b) => b.curve.length - a.curve.length)
    .slice(0, topN);
  if (qualified.length === 0) {
    return { chartData: [], seriesList: [], totalPoints: 0 };
  }
  const maxN = qualified.reduce(
    (m, s) => Math.max(m, s.curve.length),
    0,
  );
  const seriesList = qualified.map((s) => ({
    name: s.build,
    color: colorFor(s.build),
  }));
  const chartData: ChartRow[] = [];
  for (let n = 1; n <= maxN; n += 1) {
    const row: ChartRow = { n };
    for (const s of qualified) {
      const pt = s.curve[n - 1];
      if (!pt) {
        row[s.build] = null;
        continue;
      }
      const total = pt.cumulativeWins + pt.cumulativeLosses;
      row[s.build] = total > 0
        ? Math.round((pt.cumulativeWins / total) * 100)
        : null;
    }
    chartData.push(row);
  }
  const totalPoints = qualified.reduce((acc, s) => acc + s.curve.length, 0);
  return { chartData, seriesList, totalPoints };
}
