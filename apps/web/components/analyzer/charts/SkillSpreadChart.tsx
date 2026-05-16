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
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { wrColor } from "@/lib/format";

type SpreadBucket = {
  id: string;
  label: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  avgSpread: number | null;
};

type SpreadResponse = {
  buckets: SpreadBucket[];
  unknown: { total: number; wins: number; losses: number };
};

const COLOR_ACCENT = "#7c8cff";
const COLOR_GRID = "#1f2533";
const COLOR_BORDER_STRONG = "#2a3142";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_BG_SURFACE = "#11141b";

/**
 * Win rate by opponent-vs-self MMR spread.
 *
 * Five brackets: ≤-150 (you're heavily favored on paper), -150..-50,
 * ±50 (peer), +50..+150, ≥+150 (you're the underdog). Bars carry
 * the game count, the secondary line carries WR. The 50% line is
 * the coinflip baseline; the dashed accent line is your overall WR
 * across the buckets that actually had data so you can see whether
 * each bracket is over- or under-performing your average.
 *
 * Games missing either ``myMmr`` or ``opponent.mmr`` fall into a
 * separate "unknown" rollup that's surfaced as a small caption
 * below the chart — never silently dropped.
 */
export function SkillSpreadChart() {
  const { filters, dbRev } = useFilters();
  const { data, isLoading } = useApi<SpreadResponse>(
    `/v1/skill-spread${filtersToQuery(filters)}#${dbRev}`,
  );

  const { rows, baselinePct, totalKnown } = useMemo(() => {
    const buckets = data?.buckets || [];
    let wins = 0;
    let total = 0;
    for (const b of buckets) {
      wins += b.wins;
      total += b.total;
    }
    return {
      rows: buckets.map((b) => ({
        ...b,
        winRatePct: b.total > 0 ? Math.round(b.winRate * 100) : null,
        color: wrColor(b.winRate, b.total),
      })),
      baselinePct: total > 0 ? Math.round((wins / total) * 100) : null,
      totalKnown: total,
    };
  }, [data]);

  if (isLoading) {
    return (
      <Card title="Win rate by MMR spread">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (!data || totalKnown === 0) {
    return (
      <Card title="Win rate by MMR spread">
        <EmptyState
          title="No MMR-tagged games"
          sub="Once your replays carry both player and opponent MMR, this chart will split your WR by skill spread."
        />
      </Card>
    );
  }

  return (
    <Card title="Win rate by MMR spread">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Opponent MMR minus your MMR · bars = games played · line = win rate ·
        dashed accent = your average across the buckets ({baselinePct}%).
      </p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
            <XAxis
              dataKey="label"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              interval={0}
              tickMargin={4}
            />
            <YAxis
              yAxisId="games"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="wr"
              orientation="right"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <ReferenceLine
              yAxisId="wr"
              y={50}
              stroke={COLOR_BORDER_STRONG}
              strokeDasharray="2 4"
            />
            {baselinePct != null ? (
              <ReferenceLine
                yAxisId="wr"
                y={baselinePct}
                stroke={COLOR_ACCENT}
                strokeOpacity={0.45}
                strokeDasharray="4 4"
              />
            ) : null}
            <Tooltip
              cursor={{ fill: "rgba(124,140,255,0.04)" }}
              contentStyle={{
                background: COLOR_BG_SURFACE,
                border: `1px solid ${COLOR_GRID}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number, name: string, ctx) => {
                if (name === "winRatePct") {
                  if (value == null) return ["—", "Win rate"];
                  return [`${value}%`, "Win rate"];
                }
                if (name === "total") {
                  const p = (ctx as { payload?: SpreadBucket }).payload;
                  const sub =
                    p?.avgSpread != null ? ` · avg Δ ${p.avgSpread}` : "";
                  return [`${value} games${sub}`, "Sample"];
                }
                return [value, name];
              }}
            />
            <Bar
              yAxisId="games"
              dataKey="total"
              radius={[4, 4, 0, 0]}
              minPointSize={3}
            >
              {rows.map((r) => (
                <Cell key={r.id} fill={r.color} fillOpacity={0.85} />
              ))}
            </Bar>
            <Line
              yAxisId="wr"
              type="linear"
              dataKey="winRatePct"
              stroke={COLOR_ACCENT}
              strokeWidth={2.5}
              dot={{ r: 3, fill: COLOR_ACCENT }}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <SpreadFooter data={data} totalKnown={totalKnown} />
    </Card>
  );
}

function SpreadFooter({
  data,
  totalKnown,
}: {
  data: SpreadResponse;
  totalKnown: number;
}) {
  const unknown = data.unknown?.total ?? 0;
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {data.buckets.map((b) => (
        <div
          key={b.id}
          className="rounded border border-border bg-bg-elevated/50 px-2.5 py-2"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-1.5">
            <span className="whitespace-nowrap text-[11px] font-semibold text-text">
              {b.label}
            </span>
            <span
              className="whitespace-nowrap text-sm font-semibold tabular-nums"
              style={{ color: wrColor(b.winRate, b.total) }}
            >
              {b.total > 0 ? `${Math.round(b.winRate * 100)}%` : "—"}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] tabular-nums text-text-dim">
            {b.total > 0 ? `${b.wins}W · ${b.losses}L` : "no games"}
          </div>
        </div>
      ))}
      {unknown > 0 ? (
        <div className="col-span-2 mt-1 text-[10px] text-text-dim sm:col-span-5">
          Plus {unknown.toLocaleString()} game{unknown === 1 ? "" : "s"} with
          missing MMR (not shown above) · {totalKnown.toLocaleString()} games
          with both MMR values plotted.
        </div>
      ) : null}
    </div>
  );
}
