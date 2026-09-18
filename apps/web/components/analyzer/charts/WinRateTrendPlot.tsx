"use client";

import { useId, useMemo } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useChartTheme } from "@/lib/useChartTheme";
import { formatTrendDate, type WinRateTrend, type WinRateTrendPoint } from "@/lib/winRateTrend";

const percent = (value: number) => `${value.toFixed(1)}%`;
const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`);

function RecordCount({ wins, losses, games }: { wins: number; losses: number; games: number }) {
  const other = Math.max(0, games - wins - losses);
  return <>{wins.toLocaleString()}W · {losses.toLocaleString()}L{other > 0 ? ` · ${other.toLocaleString()} other` : ""}</>;
}

/** A persistent readout also exposes the important data without hover. */
export function WinRateSampleSummary({ trend, targetGames, compact = false, recordLabel = "games", interval = "day" }: {
  trend: WinRateTrend;
  targetGames: number;
  compact?: boolean;
  recordLabel?: string;
  interval?: "day" | "week" | "month";
}) {
  const latest = trend.latest;
  const ready = latest?.ready && latest.rate != null;
  if (!ready) {
    return (
      <div className="rounded-lg border border-border bg-bg-elevated/60 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-caption font-semibold text-text">Building a sample</span>
          <span className="text-caption tabular-nums text-text-muted">{trend.overall.games.toLocaleString()} / {targetGames} {recordLabel}</span>
        </div>
        <div role="progressbar" aria-label="Games toward recent-form sample" aria-valuenow={Math.min(trend.overall.games, targetGames)} aria-valuemin={0} aria-valuemax={targetGames} className="my-2 h-1.5 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, trend.overall.games / targetGames * 100)}%` }} />
        </div>
        <p className="text-caption text-text-muted">
          {Math.max(0, targetGames - trend.overall.games)} more {recordLabel} in this date range to draw recent form.
          {!compact && " Small samples can swing sharply after just one result."}
        </p>
        <p className="mt-2 text-caption tabular-nums text-text-muted">
          Recorded so far: <RecordCount {...trend.overall} />{trend.overall.rate != null ? ` · ${percent(trend.overall.rate)}` : ""}
        </p>
      </div>
    );
  }
  return (
    <div className={`flex flex-wrap items-end justify-between gap-x-4 gap-y-2 ${compact ? "mb-2" : "mb-4"}`}>
      <div>
        <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">Recent form</div>
        <div className={`${compact ? "text-2xl" : "text-4xl"} font-display font-bold leading-tight tabular-nums text-text`}>
          {percent(latest.rate!)}
        </div>
      </div>
      <div className={`${compact ? "text-micro" : "text-caption"} tabular-nums text-text-muted`}>
        <div className="font-medium text-text">{latest.sampleGames.toLocaleString()} {recordLabel} · <RecordCount wins={latest.sampleWins} losses={latest.sampleLosses} games={latest.sampleGames} /></div>
        <div>{interval !== "day" ? `${interval === "week" ? "Weeks" : "Months"} starting ` : ""}{formatTrendDate(latest.sampleStart!, true)} – {formatTrendDate(latest.date, true)}</div>
      </div>
    </div>
  );
}

export function WinRateTrendPlot({ trend, compact = false, label = "Recent win rate", dateDomain, recordLabel = "games", interval = "day" }: {
  trend: WinRateTrend;
  compact?: boolean;
  label?: string;
  dateDomain?: [string, string];
  recordLabel?: string;
  interval?: "day" | "week" | "month";
}) {
  const theme = useChartTheme();
  const descriptionId = useId();
  // Only completed samples are interactive. Preserve the full date domain so
  // sparse play and the initial sample-building period still have honest spacing.
  const points = useMemo(() => trend.points.filter((point) => point.rate != null).map((point) => ({ ...point, time: timestamp(point.date) })), [trend.points]);
  if (!trend.readyPoints) return null;
  const first = dateDomain ? timestamp(dateDomain[0]) : timestamp(trend.points.find((point) => point.games > 0)!.date);
  const last = dateDomain ? timestamp(dateDomain[1]) : timestamp(trend.latest!.date);
  const domain = first === last ? [first - 43_200_000, last + 43_200_000] : [first, last];
  const tickCount = compact ? 3 : 4;
  const ticks = first === last ? [first] : [...new Set(Array.from({ length: tickCount }, (_, index) =>
    Math.round((first + (last - first) * index / (tickCount - 1)) / 86_400_000) * 86_400_000,
  ))];
  const showYear = new Date(first).getUTCFullYear() !== new Date(last).getUTCFullYear();
  return (
    <div className="min-w-0">
      <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-text-muted ${compact ? "mb-1" : "mb-3"}`} aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-accent-cyan" />Recent form</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-text-muted" />Overall {percent(trend.overall.rate!)}</span>
      </div>
      <p id={descriptionId} className="sr-only">{label}. Game-weighted windows of at least {trend.targetGames} {recordLabel}. The dashed line is the overall win rate in the selected date range. The scale is zero to one hundred percent. Use the left and right arrow keys to explore samples.</p>
      <div className={compact ? "h-36 min-w-0" : "h-56 min-w-0 sm:h-64"}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart accessibilityLayer data={points} margin={{ top: 10, right: 10, bottom: 0, left: 0 }} aria-label={label} aria-describedby={descriptionId}>
            <CartesianGrid vertical={false} stroke={theme.border} strokeDasharray="2 5" />
            <XAxis dataKey="time" type="number" scale="time" domain={domain} ticks={ticks} tickFormatter={(value: number) => formatTrendDate(new Date(value).toISOString().slice(0, 10), showYear)} stroke={theme.textDim} axisLine={false} tickLine={false} minTickGap={compact ? 32 : 40} fontSize={10} tickMargin={10} height={32} />
            <YAxis domain={[0, 100]} ticks={compact ? [0, 50, 100] : [0, 25, 50, 75, 100]} tickFormatter={(value: number) => `${value}%`} stroke={theme.textDim} axisLine={false} tickLine={false} width={36} fontSize={10} />
            <ReferenceLine y={trend.overall.rate!} stroke={theme.textMuted} strokeDasharray="5 5" strokeOpacity={0.6} />
            <Tooltip isAnimationActive={false} cursor={{ stroke: theme.textDim, strokeDasharray: "3 4" }} wrapperStyle={{ zIndex: 10 }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0].payload as WinRateTrendPoint;
              if (point.rate == null || !point.sampleStart) return null;
              return (
                <div role="status" aria-live="polite" aria-atomic="true" className="max-w-[240px] rounded-lg border border-border-strong bg-bg-surface p-3 text-caption text-text shadow-lg">
                  <div className="mb-1 font-semibold">{interval !== "day" ? `${interval === "week" ? "Weeks" : "Months"} starting ` : ""}{formatTrendDate(point.sampleStart, true)} – {formatTrendDate(point.date, true)}</div>
                  <div className="flex items-baseline justify-between gap-4"><span>Recent form</span><strong className="text-lg tabular-nums">{percent(point.rate)}</strong></div>
                  <div className="tabular-nums text-text-muted">{point.sampleGames.toLocaleString()} {recordLabel} · <RecordCount wins={point.sampleWins} losses={point.sampleLosses} games={point.sampleGames} /></div>
                </div>
              );
            }} />
            <Line type="monotone" dataKey="rate" name="Recent form" stroke={theme.accentCyan} strokeWidth={compact ? 2.5 : 3} dot={trend.readyPoints <= 2 ? { r: 3, strokeWidth: 0, fill: theme.accentCyan } : false} activeDot={{ r: 5, stroke: theme.bgSurface, strokeWidth: 2, fill: theme.accentCyan }} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {trend.readyPoints === 1 && <p className="mt-1 text-micro text-text-muted">First sample ready. The line grows as more results arrive.</p>}
    </div>
  );
}
