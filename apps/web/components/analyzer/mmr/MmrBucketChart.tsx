"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Legend,
} from "recharts";
import { EmptyState } from "@/components/ui/Card";
import { wrColor } from "@/lib/format";

export type MmrBucketRow = {
  /** Series the row belongs to (build name or strategy name). */
  series: string;
  /** Lower bound of the MMR bucket (e.g. 4400 for the 4400–4599 bucket). */
  bucket: number;
  /** Server-stamped human label, e.g. ``"4400–4599"``. */
  label: string;
  wins: number;
  losses: number;
  games: number;
};

/**
 * MMR-bucketed multi-line chart. Reusable for "win rate of MY
 * build at MY MMR" and "win rate vs opp strategy at OPP MMR" — both
 * tabs share this primitive so the visual language stays consistent.
 *
 * Render rules:
 *   * X-axis: MMR bucket label, ordered ascending.
 *   * Y-axis: win rate %, fixed 0–100 so eye comparison across
 *     series is honest.
 *   * One coloured line per series. Color is a stable hash of the
 *     series name so the same build always reads as the same
 *     colour across tabs.
 *   * Sample-size gate: per-bucket points with ``games <
 *     minSampleSize`` are nulled out so the line skips them —
 *     prevents "100% win rate over 2 games" landmines.
 *   * 50% coinflip reference line stays visible.
 *
 * Tooltip shows wins/losses/games per series for the hovered
 * bucket. Mobile-friendly: legend wraps below the chart and the
 * x-axis ticks rotate so labels never overlap.
 *
 * No mock data: when the dataset is empty (no games yet ingested
 * with both MMRs, or filter has zero matches) the chart renders an
 * EmptyState instead of fabricated points.
 */
export function MmrBucketChart({
  rows,
  minSampleSize,
  height = 280,
  emptyTitle,
  emptySub,
}: {
  rows: MmrBucketRow[];
  minSampleSize: number;
  height?: number;
  emptyTitle?: string;
  emptySub?: string;
}) {
  const { chartData, seriesList, totalGames } = useMemo(() => {
    return shapeForChart(rows, minSampleSize);
  }, [rows, minSampleSize]);

  if (totalGames === 0) {
    return (
      <EmptyState
        title={emptyTitle || "No MMR-tagged games yet"}
        sub={
          emptySub
          || "Charts populate as games ingest with both your MMR and the opponent's MMR (both required to bucket honestly)."
        }
      />
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 16, bottom: 12, left: -8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
          <XAxis
            dataKey="label"
            stroke="#6b7280"
            fontSize={10}
            tickMargin={6}
            interval="preserveStartEnd"
            angle={-32}
            textAnchor="end"
            height={48}
          />
          <YAxis
            stroke="#6b7280"
            fontSize={11}
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            label={{
              value: "WR",
              angle: -90,
              position: "insideLeft",
              style: { fill: "#6b7280", fontSize: 10 },
              offset: 16,
            }}
          />
          <ReferenceLine
            y={50}
            stroke="#3a4252"
            strokeDasharray="2 4"
            ifOverflow="visible"
          />
          <Tooltip
            contentStyle={{
              background: "#11141b",
              border: "1px solid #1f2533",
              borderRadius: 8,
              fontSize: 12,
            }}
            content={<MmrBucketTooltip />}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            iconType="line"
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            formatter={(name: string) => (
              <span className="text-text-muted">{name}</span>
            )}
          />
          {seriesList.map((series) => (
            <Line
              key={series.name}
              type="monotone"
              dataKey={series.name}
              stroke={series.color}
              strokeWidth={2}
              dot={{ r: 3, fill: series.color }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

interface ChartRow {
  bucket: number;
  label: string;
  [series: string]: number | string | null;
}

function shapeForChart(rows: MmrBucketRow[], minSampleSize: number): {
  chartData: ChartRow[];
  seriesList: Array<{ name: string; color: string; totalGames: number }>;
  totalGames: number;
} {
  const bucketsByLabel = new Map<string, { bucket: number; label: string }>();
  const seriesAgg = new Map<
    string,
    {
      perBucket: Map<string, { wins: number; losses: number; games: number }>;
      totalGames: number;
    }
  >();
  for (const r of rows) {
    if (!bucketsByLabel.has(r.label)) {
      bucketsByLabel.set(r.label, { bucket: r.bucket, label: r.label });
    }
    let group = seriesAgg.get(r.series);
    if (!group) {
      group = { perBucket: new Map(), totalGames: 0 };
      seriesAgg.set(r.series, group);
    }
    group.perBucket.set(r.label, {
      wins: r.wins,
      losses: r.losses,
      games: r.games,
    });
    group.totalGames += r.games;
  }
  const sortedBuckets = Array.from(bucketsByLabel.values()).sort(
    (a, b) => a.bucket - b.bucket,
  );
  // Show the most-played series first in legend order (and pick the
  // most-saturated colours for the ones the user plays most).
  const seriesNames = Array.from(seriesAgg.entries())
    .sort((a, b) => b[1].totalGames - a[1].totalGames)
    .map(([name, group]) => ({
      name,
      color: colorFor(name),
      totalGames: group.totalGames,
    }));
  const chartData: ChartRow[] = sortedBuckets.map((b) => {
    /** @type {ChartRow} */
    const row: ChartRow = { bucket: b.bucket, label: b.label };
    for (const s of seriesNames) {
      const cell = seriesAgg.get(s.name)?.perBucket.get(b.label);
      if (!cell || cell.games < minSampleSize) {
        row[s.name] = null;
        row[`${s.name}__games`] = cell ? cell.games : 0;
        row[`${s.name}__wins`] = cell ? cell.wins : 0;
        row[`${s.name}__losses`] = cell ? cell.losses : 0;
        continue;
      }
      const wr = cell.wins / cell.games;
      row[s.name] = Math.round(wr * 100);
      row[`${s.name}__games`] = cell.games;
      row[`${s.name}__wins`] = cell.wins;
      row[`${s.name}__losses`] = cell.losses;
      row[`${s.name}__color`] = wrColor(wr, cell.games);
    }
    return row;
  });
  const totalGames = Array.from(seriesAgg.values()).reduce(
    (acc, g) => acc + g.totalGames,
    0,
  );
  return { chartData, seriesList: seriesNames, totalGames };
}

/**
 * Color palette — high-contrast, dark-bg-friendly, colour-blind-aware
 * (Okabe-Ito inspired set). The same series always gets the same
 * colour across charts because the index is a stable hash of the
 * series name.
 */
const PALETTE = [
  "#7c8cff", // accent blue
  "#a78bfa", // purple
  "#3ec07a", // green
  "#ff6b6b", // red
  "#f59e0b", // amber
  "#06b6d4", // cyan
  "#e879f9", // magenta
  "#84cc16", // lime
  "#fb7185", // rose
  "#22d3ee", // sky
  "#fbbf24", // yellow
  "#a3e635", // chartreuse
];

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

interface TooltipPayloadEntry {
  name?: string;
  value?: number | null;
  color?: string;
  payload?: ChartRow;
}

function MmrBucketTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  // Filter to series that actually have a non-null point in this
  // bucket — the recharts default payload includes nulled-out series
  // which clutter the tooltip.
  const rows = payload.filter(
    (p) => p && typeof p.value === "number" && p.name,
  );
  if (rows.length === 0) return null;
  const dataPayload = payload[0]?.payload;
  return (
    <div
      style={{
        background: "#11141b",
        border: "1px solid #1f2533",
        borderRadius: 8,
        padding: "6px 10px",
        fontSize: 12,
        maxWidth: 280,
      }}
    >
      <div className="mb-1 font-semibold text-text">{label} MMR</div>
      <ul className="space-y-0.5">
        {rows.map((r) => {
          const name = r.name as string;
          const games = Number(dataPayload?.[`${name}__games`]) || 0;
          const wins = Number(dataPayload?.[`${name}__wins`]) || 0;
          const losses = Number(dataPayload?.[`${name}__losses`]) || 0;
          return (
            <li
              key={name}
              className="flex items-baseline justify-between gap-3"
              style={{ color: r.color }}
            >
              <span className="truncate">{name}</span>
              <span className="tabular-nums">
                <span className="font-semibold">{r.value}%</span>
                <span className="ml-1 text-text-dim">
                  {wins}–{losses} · {games}g
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
