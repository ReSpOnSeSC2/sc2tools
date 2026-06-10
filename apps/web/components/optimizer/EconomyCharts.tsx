"use client";

/**
 * Economy time-series for the optimized build: banked resources,
 * income rate, worker count, and supply usage vs cap — sampled
 * directly from the simulation.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "@/components/ui/Card";
import { formatBuildTime } from "@/lib/build-events";
import { useChartTheme, useReducedMotion } from "@/lib/useChartTheme";
import type { AdaptResult } from "@/lib/optimizer/types";

export function EconomyCharts({ result }: { result: AdaptResult | null }) {
  const theme = useChartTheme();
  const reducedMotion = useReducedMotion();
  if (!result) return null;
  const data = result.sim.samples.map((s) => ({
    ...s,
    label: formatBuildTime(s.time),
  }));
  const common = {
    data,
    margin: { top: 8, right: 8, bottom: 0, left: -16 },
  };
  const axisProps = {
    stroke: theme.textDim,
    tick: { fill: theme.textMuted, fontSize: 11 },
    tickLine: false,
  };
  const tooltipStyle = {
    backgroundColor: theme.bgElevated,
    border: `1px solid ${theme.border}`,
    borderRadius: 8,
    color: theme.text,
    fontSize: 12,
  };
  return (
    <Card title="Economy">
      <div className="grid gap-4 p-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-caption font-medium text-text-muted">
            Bank (minerals / gas)
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart {...common}>
              <CartesianGrid stroke={theme.border} strokeDasharray="3 3" />
              <XAxis dataKey="label" {...axisProps} minTickGap={32} />
              <YAxis {...axisProps} width={56} />
              <Tooltip
                contentStyle={tooltipStyle}
                isAnimationActive={!reducedMotion}
              />
              <Area
                type="monotone"
                dataKey="minerals"
                name="Minerals"
                stroke={theme.accentCyan}
                fill={theme.accentCyan}
                fillOpacity={0.25}
                isAnimationActive={!reducedMotion}
              />
              <Area
                type="monotone"
                dataKey="gas"
                name="Gas"
                stroke={theme.success}
                fill={theme.success}
                fillOpacity={0.25}
                isAnimationActive={!reducedMotion}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div className="mb-1 text-caption font-medium text-text-muted">
            Workers & supply
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart {...common}>
              <CartesianGrid stroke={theme.border} strokeDasharray="3 3" />
              <XAxis dataKey="label" {...axisProps} minTickGap={32} />
              <YAxis {...axisProps} width={40} />
              <Tooltip
                contentStyle={tooltipStyle}
                isAnimationActive={!reducedMotion}
              />
              <Line
                type="stepAfter"
                dataKey="workers"
                name="Workers"
                stroke={theme.accent}
                dot={false}
                isAnimationActive={!reducedMotion}
              />
              <Line
                type="stepAfter"
                dataKey="supplyUsed"
                name="Supply used"
                stroke={theme.warning}
                dot={false}
                isAnimationActive={!reducedMotion}
              />
              <Line
                type="stepAfter"
                dataKey="supplyCap"
                name="Supply cap"
                stroke={theme.textDim}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={!reducedMotion}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
}
