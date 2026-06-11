"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Cell,
} from "recharts";
import { Card, EmptyState } from "@/components/ui/Card";
import { wrColor } from "@/lib/format";
import { ChartTooltip } from "../../charts/ChartTooltip";
import type { ReportDrill, ScoreBucketRow } from "./types";

/**
 * "Does macro win you games?" — win rate by macro-score bucket.
 *
 * Bars are game counts coloured by the analyzer's WR ramp; the line is
 * the bucket's win rate with a 50% coinflip reference. Clicking a
 * bucket (bar or summary tile) opens the exact games behind it via the
 * games-list macro_min / macro_max filters — the bucket edges travel
 * with the row so the modal's cohort always matches the bar.
 */
export function ScoreBucketsCard({
  buckets,
  onDrill,
}: {
  buckets: ScoreBucketRow[];
  onDrill: (drill: ReportDrill) => void;
}) {
  const rows = useMemo(
    () =>
      buckets.map((b) => ({
        ...b,
        winRatePct: b.winRate == null ? null : Math.round(b.winRate * 100),
        color: wrColor(b.winRate, b.games),
      })),
    [buckets],
  );
  const total = rows.reduce((acc, r) => acc + r.games, 0);

  const drillFor = (r: ScoreBucketRow): ReportDrill => ({
    title: `Games with macro ${r.label}`,
    params: {
      ...(r.min !== null ? { macro_min: r.min } : {}),
      ...(r.max !== null ? { macro_max: r.max } : {}),
      // The lowest bucket has no macro_min; macro_max alone still
      // excludes unscored games because the API range-matches the
      // numeric macroScore field.
    },
  });

  if (total === 0) {
    return (
      <Card title="Does macro win you games?">
        <EmptyState
          title="No scored games yet"
          sub="Macro scores appear as the agent uploads (or backfills) replays."
        />
      </Card>
    );
  }

  return (
    <Card title="Does macro win you games?">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Win rate by macro score · bar = games · click a bucket to see those
        games.
      </p>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 24, bottom: 0, left: -8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
            <XAxis dataKey="label" stroke="#6b7280" fontSize={11} tickMargin={6} />
            <YAxis
              yAxisId="games"
              stroke="#6b7280"
              fontSize={11}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="wr"
              orientation="right"
              stroke="#6b7280"
              fontSize={11}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <ReferenceLine
              yAxisId="wr"
              y={50}
              stroke="#3a4252"
              strokeDasharray="2 4"
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const r = payload[0].payload as (typeof rows)[number];
                return (
                  <ChartTooltip
                    header={`Macro ${r.label}`}
                    rows={[
                      {
                        key: "wr",
                        label: "Win rate",
                        value: r.winRatePct == null ? "—" : `${r.winRatePct}%`,
                      },
                      {
                        key: "games",
                        label: "Games",
                        value: `${r.wins}W · ${r.losses}L · ${r.games}`,
                      },
                    ]}
                  />
                );
              }}
            />
            <Bar
              yAxisId="games"
              dataKey="games"
              radius={[4, 4, 0, 0]}
              minPointSize={3}
              cursor="pointer"
              onClick={(data) => {
                const r = (data as { payload?: ScoreBucketRow }).payload;
                if (r && r.games > 0) onDrill(drillFor(r));
              }}
            >
              {rows.map((r) => (
                <Cell key={r.key} fill={r.color} fillOpacity={0.85} />
              ))}
            </Bar>
            <Line
              yAxisId="wr"
              type="linear"
              dataKey="winRatePct"
              stroke="#7c8cff"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "#7c8cff" }}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            disabled={r.games === 0}
            onClick={() => onDrill(drillFor(r))}
            className="rounded border border-border bg-bg-elevated/50 px-2.5 py-2 text-left transition-colors enabled:hover:border-border-strong enabled:hover:bg-bg-elevated disabled:opacity-50"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-1.5 gap-y-0.5">
              <span className="whitespace-nowrap text-micro font-semibold text-text">
                {r.label}
              </span>
              <span
                className="whitespace-nowrap text-sm font-semibold tabular-nums"
                style={{ color: r.color }}
              >
                {r.winRatePct == null ? "—" : `${r.winRatePct}%`}
              </span>
            </div>
            <div className="mt-0.5 text-micro tabular-nums text-text-dim">
              {r.games > 0
                ? `${r.wins}W · ${r.losses}L · ${r.games} game${r.games === 1 ? "" : "s"}`
                : "no games"}
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}
