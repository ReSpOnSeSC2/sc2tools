"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { useLocalStoragePositiveInt } from "@/lib/useLocalStorageState";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { fmtMmr } from "@/lib/format";

interface ProgressionPoint {
  date: string;
  mmr: number;
  result: "win" | "loss";
}

interface BuildSeries {
  build: string;
  points: ProgressionPoint[];
}

const LS_MIN_GAMES = "analyzer.mmr.progression.minGames";
const LS_TOP_N = "analyzer.mmr.progression.topN";

/**
 * MMR progression by build — for each build the streamer plays, a
 * line showing the streamer's OWN MMR at the time of each game.
 *
 * Answers a question win rate alone can't: "when I'm using build X,
 * what does my MMR look like?" If the line trends UP over the time
 * you've played that build, the build is helping you climb. If it's
 * FLAT or DOWN, you're stalled on that opening regardless of the
 * raw win-rate number.
 *
 * Plotted with date on the x-axis (truncated to the day) and your
 * MMR on the y-axis. One coloured line per build. Mobile-friendly:
 * x-axis ticks rotate, legend wraps below the chart.
 *
 * No mock data: an empty response renders an EmptyState pointing at
 * the actual gap (no MMR-tagged games yet for any build that
 * passes the min-plays threshold).
 */
export function MmrProgressionByBuild() {
  const { filters, dbRev } = useFilters();
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_GAMES, 10);
  const [topN, setTopN] = useLocalStoragePositiveInt(LS_TOP_N, 5);

  const { data, isLoading } = useApi<BuildSeries[]>(
    `/v1/mmr-stats/progression${filtersToQuery(filters)}#${dbRev}`,
  );

  const { chartData, seriesList, totalPoints, mmrDomain } = useMemo(
    () => shapeProgressionForChart(data || [], minGames, topN),
    [data, minGames, topN],
  );

  return (
    <Card title="MMR progression by build">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Each line is your MMR over time when playing a given build · Climbing
        lines indicate the build moves your MMR up · Flat / falling lines
        mean you're stalling or sliding when you queue it.
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-micro uppercase tracking-wider text-text-dim">
            Min plays per build
          </span>
          <MinGamesPicker value={minGames} onChange={setMinGames} hideLabel />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-micro uppercase tracking-wider text-text-dim">
            Builds shown (top N by volume)
          </span>
          <MinGamesPicker
            value={topN}
            onChange={setTopN}
            steps={[3, 5, 10, 20]}
            hideLabel
          />
        </div>
      </div>

      <div className="mt-4" style={{ height: 280 }}>
        {isLoading ? (
          <Skeleton rows={4} />
        ) : totalPoints === 0 ? (
          <EmptyState
            title="No MMR-tagged builds yet"
            sub="Lines appear once a build crosses the min-plays threshold above and has MMR data on each game."
          />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 16, left: -8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
              <XAxis
                dataKey="dateLabel"
                stroke="#6b7280"
                fontSize={10}
                tickMargin={6}
                interval="preserveStartEnd"
                angle={-30}
                textAnchor="end"
                height={48}
              />
              <YAxis
                stroke="#6b7280"
                fontSize={11}
                domain={mmrDomain}
                allowDecimals={false}
                tickFormatter={(v: number) => fmtMmr(v)}
              />
              <Tooltip
                contentStyle={{
                  background: "#11141b",
                  border: "1px solid #1f2533",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => [
                  `${value} MMR`,
                  name,
                ]}
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
                  connectNulls
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

// Palette ordered so adjacent indices are maximally distinct hues
// (blue → orange → green → magenta → yellow → cyan → red → lime → …)
// rather than the prior version's blue/purple/green/red cluster which
// produced near-identical lines on real datasets with 3+ Protoss builds.
const PALETTE = [
  "#3b82f6", // blue
  "#f97316", // orange
  "#10b981", // emerald
  "#ec4899", // pink
  "#eab308", // yellow
  "#06b6d4", // cyan
  "#ef4444", // red
  "#84cc16", // lime
  "#a855f7", // purple
  "#14b8a6", // teal
  "#fb923c", // light orange
  "#22d3ee", // light cyan
  "#e879f9", // fuchsia
  "#fbbf24", // amber
  "#4ade80", // light green
  "#f43f5e", // rose
];

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Assign a palette color to each series so (a) the same build tends to
 * land on the same color across re-renders (hash-based slot preference)
 * AND (b) no two visible series share a color even when their hashes
 * collide on the same slot. Collisions step forward through the palette
 * until an unused slot is found; if every slot is taken the assignment
 * wraps and the last few series intentionally repeat colors. With a
 * 16-entry palette this only happens past topN=16.
 */
function assignColors(names: ReadonlyArray<string>): Map<string, string> {
  const used = new Set<number>();
  const out = new Map<string, string>();
  for (const name of names) {
    let idx = hashName(name) % PALETTE.length;
    let steps = 0;
    while (used.has(idx) && steps < PALETTE.length) {
      idx = (idx + 1) % PALETTE.length;
      steps += 1;
    }
    used.add(idx);
    out.set(name, PALETTE[idx]);
  }
  return out;
}

interface ChartRow {
  dateKey: string;
  dateLabel: string;
  [series: string]: number | string | null;
}

function shapeProgressionForChart(
  series: BuildSeries[],
  minPlays: number,
  topN: number,
): {
  chartData: ChartRow[];
  seriesList: Array<{ name: string; color: string }>;
  totalPoints: number;
  mmrDomain: [number, number] | ["dataMin", "dataMax"];
} {
  const qualified = series
    .filter((s) => s.points.length >= minPlays)
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, topN);
  if (qualified.length === 0) {
    return {
      chartData: [],
      seriesList: [],
      totalPoints: 0,
      mmrDomain: ["dataMin", "dataMax"],
    };
  }
  // Build a date-keyed row index: each row holds the latest MMR
  // for each build on that day (one game per build per day is
  // typical; multi-day chunks collapse to the last point so the
  // line plots cleanly).
  const rowByKey = new Map<string, ChartRow>();
  let minMmr = Infinity;
  let maxMmr = -Infinity;
  for (const s of qualified) {
    for (const pt of s.points) {
      const d = new Date(pt.date);
      if (Number.isNaN(d.getTime())) continue;
      const dateKey = d.toISOString().slice(0, 10);
      let row = rowByKey.get(dateKey);
      if (!row) {
        row = {
          dateKey,
          dateLabel: d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }),
        };
        rowByKey.set(dateKey, row);
      }
      row[s.build] = pt.mmr;
      if (pt.mmr < minMmr) minMmr = pt.mmr;
      if (pt.mmr > maxMmr) maxMmr = pt.mmr;
    }
  }
  const chartData = Array.from(rowByKey.values()).sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey),
  );
  const colors = assignColors(qualified.map((s) => s.build));
  const seriesList = qualified.map((s) => ({
    name: s.build,
    color: colors.get(s.build) || PALETTE[0],
  }));
  const totalPoints = qualified.reduce((acc, s) => acc + s.points.length, 0);
  // Pad the y-axis domain so the lines don't sit on the edges.
  const pad = Math.max(50, Math.round((maxMmr - minMmr) * 0.1));
  const mmrDomain: [number, number] = [
    Math.max(0, Math.floor((minMmr - pad) / 50) * 50),
    Math.ceil((maxMmr + pad) / 50) * 50,
  ];
  return { chartData, seriesList, totalPoints, mmrDomain };
}
