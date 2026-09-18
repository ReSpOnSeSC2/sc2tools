"use client";

import { useMemo } from "react";
import { Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/Card";
import { useChartTheme } from "@/lib/useChartTheme";
import { buildActivityBuckets, type ActivityBucket } from "@/lib/activityBuckets";
import { formatTrendDate, type WinRatePeriod } from "@/lib/winRateTrend";
import { ChartTooltip } from "./ChartTooltip";

export function ActivityVolumeChart({ periods, interval, isGlobal = false }: {
  periods: readonly WinRatePeriod[];
  interval: "day" | "week" | "month";
  isGlobal?: boolean;
}) {
  const theme = useChartTheme();
  const { rows, periodsPerBar } = useMemo(() => buildActivityBuckets(periods, interval), [periods, interval]);
  const wins = rows.reduce((sum, row) => sum + row.wins, 0);
  const losses = rows.reduce((sum, row) => sum + row.losses, 0);
  const other = rows.reduce((sum, row) => sum + row.other, 0);
  return <Card title="Games played" className="min-w-0">
    <p className="mb-3 text-caption text-text-muted">
      {periodsPerBar > 1 ? "Up to " : ""}{periodsPerBar} {interval}{periodsPerBar === 1 ? "" : "s"} per bar{periodsPerBar > 1 ? " · adjacent periods combined to keep this view readable" : ""}.
    </p>
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-caption tabular-nums text-text-muted">
      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-success" aria-hidden />{wins.toLocaleString()} wins</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-danger" aria-hidden />{losses.toLocaleString()} losses</span>
      {other > 0 && <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-text-dim" aria-hidden />{other.toLocaleString()} other</span>}
    </div>
    <div className="h-56 min-w-0 sm:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart accessibilityLayer aria-label={`${isGlobal ? "Player game records" : "Games played"} over time. Stacked wins, losses, and other results.`} data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={theme.border} strokeDasharray="2 5" />
          <XAxis dataKey="date" tickFormatter={(date: string) => formatTrendDate(date)} minTickGap={36} tickMargin={10} fontSize={10} height={32} stroke={theme.textDim} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} domain={[0, "auto"]} width={32} fontSize={10} stroke={theme.textDim} axisLine={false} tickLine={false} />
          <Tooltip isAnimationActive={false} cursor={{ fill: theme.accent, fillOpacity: 0.06 }} content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as ActivityBucket;
            return <ChartTooltip header={`${interval === "day" ? "" : `${interval === "week" ? "Weeks" : "Months"} starting `}${row.label}`} rows={[
              { label: isGlobal ? "Player game records" : "Games", value: row.games },
              { label: "Wins", value: row.wins, dot: theme.success },
              { label: "Losses", value: row.losses, dot: theme.danger },
              ...(row.other ? [{ label: "Other results", value: row.other, dot: theme.textDim }] : []),
            ]} />;
          }} />
          <Bar dataKey="wins" stackId="games" fill={theme.success} maxBarSize={32} isAnimationActive={false} />
          <Bar dataKey="losses" stackId="games" fill={theme.danger} maxBarSize={32} isAnimationActive={false} />
          {other > 0 && <Bar dataKey="other" stackId="games" fill={theme.textDim} maxBarSize={32} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <p className="mt-3 text-micro text-text-muted">Bar height shows {isGlobal ? "player game records" : "games played"}. Empty periods stay visible.{other > 0 ? " Other records have no win/loss result." : ""}</p>
  </Card>;
}
