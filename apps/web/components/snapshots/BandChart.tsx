"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import {
  AXIS_LINE,
  GRID_LINE,
  OPP_LINE,
  RIBBON_LOSER,
  RIBBON_WINNER,
  USER_LINE,
} from "./shared/colorScales";
import { fmtTick, type CohortTick, type GameTick, type MetricKey } from "./shared/snapshotTypes";

// One metric × side band chart. Renders:
//   - Two stacked ribbons: winner (green, p25w..p75w) and loser
//     (red, p25l..p75l) percentile envelopes
//   - User's value as a solid yellow line
//   - Opponent's value as a dashed violet line
//   - Cursor reference line when the synced hook reports a focused tick
//
// `compact` shrinks the height for the 2x2 grid view; the default
// height suits a single-chart drilldown.

export interface BandChartProps {
  title: string;
  metric: MetricKey;
  cohort: CohortTick[];
  gameTicks?: GameTick[];
  cursorTick?: number | null;
  onHover?: (t: number | null) => void;
  compact?: boolean;
  hideOpp?: boolean;
}

export function BandChart({
  title,
  metric,
  cohort,
  gameTicks,
  cursorTick,
  onHover,
  compact = false,
  hideOpp = false,
}: BandChartProps) {
  const rows = useMemo(() => buildRows(cohort, gameTicks, metric, hideOpp), [
    cohort,
    gameTicks,
    metric,
    hideOpp,
  ]);

  if (rows.length === 0) {
    return (
      <Card title={title}>
        <div className="py-8 text-center text-caption text-text-dim">
          Not enough cohort data for this metric.
        </div>
      </Card>
    );
  }

  const height = compact ? 220 : 320;

  return (
    <Card title={title}>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 16, bottom: 12, left: 4 }}
            onMouseMove={(state) => {
              if (!onHover) return;
              const t = (state as { activeLabel?: number }).activeLabel;
              if (typeof t === "number") onHover(t);
            }}
            onMouseLeave={() => onHover?.(null)}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, 1200]}
              ticks={[0, 180, 360, 540, 720, 900, 1080]}
              tickFormatter={(v: number) => fmtTick(v)}
              stroke={AXIS_LINE}
              fontSize={11}
            />
            <YAxis stroke={AXIS_LINE} fontSize={11} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                background: "#11141b",
                border: "1px solid #1f2533",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) => fmtTick(Number(v))}
              formatter={(value: number | string, name: string) => {
                if (value === null || value === undefined) return ["—", name];
                return [
                  typeof value === "number" ? Math.round(value) : value,
                  TOOLTIP_NAMES[name] || name,
                ];
              }}
            />
            <Area
              type="monotone"
              dataKey="loserRibbon"
              stroke="transparent"
              fill={RIBBON_LOSER}
              isAnimationActive={false}
              activeDot={false}
            />
            <Area
              type="monotone"
              dataKey="winnerRibbon"
              stroke="transparent"
              fill={RIBBON_WINNER}
              isAnimationActive={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="winnerMedian"
              stroke="rgba(34, 197, 94, 0.7)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="loserMedian"
              stroke="rgba(239, 68, 68, 0.7)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="myValue"
              stroke={USER_LINE}
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            {hideOpp ? null : (
              <Line
                type="monotone"
                dataKey="oppValue"
                stroke={OPP_LINE}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            )}
            {typeof cursorTick === "number" ? (
              <ReferenceLine x={cursorTick} stroke={USER_LINE} strokeDasharray="2 2" />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

const TOOLTIP_NAMES: Record<string, string> = {
  myValue: "You",
  oppValue: "Opponent",
  winnerMedian: "Winners median",
  loserMedian: "Losers median",
  winnerRibbon: "Winners P25–P75",
  loserRibbon: "Losers P25–P75",
};

function buildRows(
  cohort: CohortTick[],
  gameTicks: GameTick[] | undefined,
  metric: MetricKey,
  _hideOpp: boolean,
) {
  const myByTick = new Map<number, GameTick>();
  if (gameTicks) {
    for (const g of gameTicks) myByTick.set(g.t, g);
  }
  return cohort
    .map((row) => {
      const myBand = row.my?.[metric];
      const game = myByTick.get(row.t);
      if (!myBand) return null;
      const winnerLow = myBand.p25w;
      const winnerHigh = myBand.p75w;
      const loserLow = myBand.p25l;
      const loserHigh = myBand.p75l;
      return {
        t: row.t,
        winnerRibbon: [winnerLow, winnerHigh],
        loserRibbon: [loserLow, loserHigh],
        winnerMedian: myBand.p50w,
        loserMedian: myBand.p50l,
        myValue: game?.my.value?.[metric] ?? null,
        oppValue: game?.opp.value?.[metric] ?? null,
      };
    })
    .filter(Boolean);
}
