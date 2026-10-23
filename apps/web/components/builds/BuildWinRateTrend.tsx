"use client";

import { useId, useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtDate } from "@/lib/format";
import { rollingWinRate, type RollingWinRatePoint, type TrendGame } from "@/lib/buildWinRateTrend";
import { useChartTheme } from "@/lib/useChartTheme";

const percent = (value: number) => `${Math.round(value)}%`;

/**
 * BuildWinRateTrend — the build's win rate over its last 10 games,
 * rolling across the recent games the dossier returns (newest 50): one
 * point per game once 10 games with a result exist. Below that it says
 * there aren't enough games instead of drawing a misleading line.
 */
export function BuildWinRateTrend({ recent }: { recent: ReadonlyArray<TrendGame> }) {
  const theme = useChartTheme();
  const descriptionId = useId();
  const trend = useMemo(() => rollingWinRate(recent), [recent]);
  const latest = trend.points[trend.points.length - 1];

  if (!latest) {
    return (
      <div className="py-6 text-center">
        <p className="text-body font-medium text-text">Not enough games for a trend</p>
        <p className="mt-1 text-caption text-text-muted">
          The line starts after {trend.window} games with a win or loss.{" "}
          {trend.decided === 0
            ? "None yet."
            : `${trend.decided} so far.`}
        </p>
      </div>
    );
  }

  const first = trend.points[0];
  // A single point still needs a span to sit in the middle of.
  const xDomain: [number, number] =
    first.game === latest.game
      ? [first.game - 1, latest.game + 1]
      : [first.game, latest.game];
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
            Last {trend.window} games
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums text-text">
            {percent(latest.rate)}
          </div>
        </div>
        <div className="font-mono text-caption tabular-nums text-text-muted">
          {latest.wins}W · {latest.losses}L
        </div>
      </div>
      <p id={descriptionId} className="sr-only">
        Win rate over each run of {trend.window} games, from game {first.game} to game{" "}
        {latest.game} of your latest {trend.decided} games with a result. It moved from{" "}
        {percent(first.rate)} to {percent(latest.rate)}. The dashed line marks 50 percent.
      </p>
      <div className="h-40 min-w-0 sm:h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            accessibilityLayer
            data={trend.points}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            aria-label={`Rolling ${trend.window}-game win rate`}
            aria-describedby={descriptionId}
          >
            <CartesianGrid vertical={false} stroke={theme.border} strokeDasharray="2 5" />
            <XAxis
              dataKey="game"
              type="number"
              domain={xDomain}
              allowDecimals={false}
              tickFormatter={(value: number) => `#${value}`}
              stroke={theme.textDim}
              axisLine={false}
              tickLine={false}
              fontSize={10}
              minTickGap={24}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(value: number) => `${value}%`}
              stroke={theme.textDim}
              axisLine={false}
              tickLine={false}
              width={36}
              fontSize={10}
            />
            <ReferenceLine y={50} stroke={theme.textMuted} strokeDasharray="5 5" strokeOpacity={0.6} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: theme.textDim, strokeDasharray: "3 4" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0].payload as RollingWinRatePoint;
                return (
                  <div className="rounded-lg border border-border-strong bg-bg-surface p-3 text-caption text-text shadow-lg">
                    <div className="font-semibold">
                      Games {point.game - trend.window + 1}–{point.game}
                    </div>
                    <div className="tabular-nums">
                      {percent(point.rate)} · {point.wins}W {point.losses}L
                    </div>
                    <div className="text-text-muted">Up to {fmtDate(point.date)}</div>
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="rate"
              name="Win rate"
              stroke={theme.accentCyan}
              strokeWidth={2.5}
              dot={trend.points.length <= 2 ? { r: 3, strokeWidth: 0, fill: theme.accentCyan } : false}
              activeDot={{ r: 5, stroke: theme.bgSurface, strokeWidth: 2, fill: theme.accentCyan }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-micro text-text-muted">
        Each point is your win rate over the {trend.window} games up to it, oldest on the left.
        Uses your latest {trend.decided} games with a win or loss.
      </p>
    </div>
  );
}
