"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { Card, EmptyState } from "@/components/ui/Card";
import type { Period } from "@/lib/timeseries";
import { ChartTooltip } from "./ChartTooltip";

const COLOR_CYAN = "#3ce0d6"; // --accent-cyan (dark theme)
const COLOR_SUCCESS = "#3ec07a";
const COLOR_WARNING = "#e6b450";
const COLOR_GRID = "#1f2533";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_BG_SURFACE = "#11141b";
const COLOR_BORDER_STRONG = "#2a3142";

/**
 * Macro score over time. Consumes the same /v1/timeseries series the
 * Trends tab already fetched (each bucket now carries avgMacroScore),
 * so this chart costs zero extra requests. Buckets whose games all
 * predate macro scoring come back null and the line skips them via
 * connectNulls instead of plunging to zero.
 *
 * Reference bands mirror the score tones used everywhere else
 * (lib/macro.ts scoreTone): ≥75 success, 50–74 warning, <50 danger.
 */
export function MacroTrendChart({ series }: { series: Period[] }) {
  const rows = useMemo(
    () =>
      series.map((p) => ({
        date: p.date,
        score: typeof p.avgMacroScore === "number" ? p.avgMacroScore : null,
        games: p.games,
      })),
    [series],
  );
  const hasAny = rows.some((r) => r.score != null);

  if (!hasAny) {
    return (
      <Card title="Macro score over time">
        <EmptyState
          title="No macro scores yet"
          sub="Scores appear once your agent uploads games with a macro breakdown — the Macro tab can backfill older replays."
        />
      </Card>
    );
  }

  return (
    <Card title="Macro score over time">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Average macro score per period · 75+ is clean macro, under 50 means
        the leaks are costing you games. Drill into any single game on the
        Macro tab.
      </p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 24, bottom: 4, left: 4 }}
          >
            <defs>
              <linearGradient id="macroTrendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_CYAN} stopOpacity={0.3} />
                <stop offset="100%" stopColor={COLOR_CYAN} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
            <XAxis
              dataKey="date"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              minTickGap={28}
              tickMargin={6}
            />
            <YAxis
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              width={36}
              tickMargin={4}
            />
            <ReferenceLine
              y={75}
              stroke={COLOR_SUCCESS}
              strokeOpacity={0.45}
              strokeDasharray="4 4"
              label={{
                value: "75",
                position: "right",
                fill: COLOR_SUCCESS,
                fontSize: 10,
              }}
            />
            <ReferenceLine
              y={50}
              stroke={COLOR_WARNING}
              strokeOpacity={0.4}
              strokeDasharray="4 4"
              label={{
                value: "50",
                position: "right",
                fill: COLOR_WARNING,
                fontSize: 10,
              }}
            />
            <Tooltip
              cursor={{ stroke: COLOR_CYAN, strokeDasharray: "3 3" }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const row = payload[0].payload as {
                  score: number | null;
                  games: number;
                };
                if (row.score == null) return null;
                return (
                  <ChartTooltip
                    header={String(label)}
                    rows={[
                      {
                        key: "score",
                        label: "Avg macro score",
                        value: row.score,
                        dot: COLOR_CYAN,
                      },
                      {
                        key: "games",
                        label: "Games",
                        value: row.games,
                        dot: COLOR_TEXT_DIM,
                      },
                    ]}
                  />
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="score"
              stroke="none"
              fill="url(#macroTrendFill)"
              connectNulls
              isAnimationActive={false}
              activeDot={false}
              legendType="none"
            />
            <Line
              type="monotone"
              dataKey="score"
              stroke={COLOR_CYAN}
              strokeWidth={2.5}
              connectNulls
              dot={{ r: 3, strokeWidth: 0, fill: COLOR_CYAN }}
              activeDot={{
                r: 5,
                strokeWidth: 2,
                stroke: COLOR_BG_SURFACE,
                fill: COLOR_CYAN,
              }}
              isAnimationActive={false}
            />
            <ReferenceLine
              y={0}
              stroke={COLOR_BORDER_STRONG}
              strokeWidth={1}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
