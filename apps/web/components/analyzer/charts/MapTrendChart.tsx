"use client";

import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { MapArtwork } from "@/components/maps/MapArtwork";
import { wrColor } from "@/lib/format";
import { clientTimezone, localDateKey } from "@/lib/timeseries";
import { ChartTooltip } from "./ChartTooltip";

type MapPoint = {
  bucket: string;
  key: string;
  wins: number;
  losses: number;
  total: number;
};

type MapResponse = {
  interval: "day" | "week" | "month";
  points: MapPoint[];
};

type PanelPoint = {
  date: string;
  wins: number;
  losses: number;
  total: number;
  winRatePct: number | null;
  rollingPct: number | null;
};

const COLOR_GRID = "#1f2533";
const COLOR_BORDER_STRONG = "#2a3142";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_ACCENT = "#7c8cff";

const TOP_N_OPTIONS = [4, 6, 8] as const;
const DEFAULT_TOP_N = 6;
const ROLL_BY_BUCKET: Record<"day" | "week" | "month", number> = {
  day: 7,
  week: 4,
  month: 2,
};

/**
 * Per-map WR over time, rendered as a grid of small multiples for
 * the user's top-N maps by volume in the visible window.
 *
 * Each panel shares the same Y axis (0-100%) and the global X
 * axis (bucket dates) so the eye can scan across to spot a map
 * that's quietly dipped while the others held steady. The 50%
 * coinflip reference is on every panel; a dashed per-map line at
 * that map's overall WR shows whether the rolling trace is above
 * or below its own baseline.
 */
export function MapTrendChart({
  bucket,
}: {
  bucket: "day" | "week" | "month";
}) {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: bucket, tz }),
    [filters, bucket, tz],
  );
  const { data, isLoading } = useApi<MapResponse>(
    `/v1/timeseries/maps${filtersToQuery(params)}#${dbRev}`,
  );
  const [topN, setTopN] = useState<number>(DEFAULT_TOP_N);
  const rollWindow = ROLL_BY_BUCKET[bucket];

  const { panels, totalGames, dateRange } = useMemo(
    () => shapeMaps(data?.points || [], tz, topN, rollWindow),
    [data, tz, topN, rollWindow],
  );

  const showYearTicks = useMemo(() => {
    if (!dateRange.earliest || !dateRange.latest) return false;
    // Spanning years — or ending in a past one — both need the year.
    if (dateRange.earliest.slice(0, 4) !== dateRange.latest.slice(0, 4)) {
      return true;
    }
    return dateRange.latest.slice(0, 4) !== String(new Date().getFullYear());
  }, [dateRange]);

  if (isLoading) {
    return (
      <Card title="Map performance over time">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (totalGames === 0 || panels.length === 0) {
    return (
      <Card title="Map performance over time">
        <EmptyState
          title="No map data to chart yet"
          sub="Once you've played a few games on a handful of maps, per-map trend lines appear here."
        />
      </Card>
    );
  }

  const intervalLabel =
    bucket === "day" ? "daily" : bucket === "week" ? "weekly" : "monthly";

  return (
    <Card
      title="Map performance over time"
      right={
        <div className="flex items-center gap-1 text-micro">
          <span className="text-text-dim">Top</span>
          {TOP_N_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setTopN(n)}
              className={[
                "rounded px-2 py-0.5",
                topN === n
                  ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                  : "bg-bg-elevated text-text-muted hover:text-text",
              ].join(" ")}
            >
              {n}
            </button>
          ))}
        </div>
      }
    >
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        One panel per top map (by volume) · faint = {intervalLabel} WR, bold ={" "}
        {rollWindow}-period rolling · dashed reference = that map's overall WR.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {panels.map((p) => (
          <MapPanel key={p.label} panel={p} showYear={showYearTicks} />
        ))}
      </div>
    </Card>
  );
}

function MapPanel({
  panel,
  showYear,
}: {
  panel: {
    label: string;
    series: PanelPoint[];
    totalGames: number;
    totalWins: number;
    recentDelta: number | null;
    color: string;
    overallWrPct: number;
  };
  showYear: boolean;
}) {
  const trendBadge =
    panel.recentDelta != null && panel.totalGames >= 6 ? (
      <span
        className={
          panel.recentDelta >= 3
            ? "text-success"
            : panel.recentDelta <= -3
              ? "text-danger"
              : "text-text-dim"
        }
        title={`Recent form vs overall: ${panel.recentDelta > 0 ? "+" : ""}${panel.recentDelta} pts`}
      >
        {panel.recentDelta > 0 ? "▲" : panel.recentDelta < 0 ? "▼" : "▬"}{" "}
        {Math.abs(panel.recentDelta)}%
      </span>
    ) : null;
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
      {/* The map's real artwork thumbnail anchors the panel — the
          MapArtwork resolver falls back to an initials tile when a
          map has no image, so nothing here is ever placeholder data. */}
      <div className="mb-2 flex items-center gap-2.5">
        <MapArtwork
          mapName={panel.label}
          size="md"
          alt={panel.label}
          className="rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-caption font-semibold text-text"
            title={panel.label}
          >
            {panel.label}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-caption tabular-nums">
            <span className="font-semibold" style={{ color: panel.color }}>
              {panel.overallWrPct}%
            </span>
            <span className="text-text-dim">
              {panel.totalGames} game{panel.totalGames === 1 ? "" : "s"}
            </span>
            {trendBadge}
          </div>
        </div>
      </div>
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={panel.series}
            margin={{ top: 4, right: 8, bottom: 0, left: -8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
            <XAxis
              dataKey="date"
              stroke={COLOR_TEXT_DIM}
              fontSize={10}
              tickFormatter={(v) => formatTick(v, showYear)}
              minTickGap={32}
              tickMargin={2}
            />
            <YAxis
              stroke={COLOR_TEXT_DIM}
              fontSize={10}
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(v) => `${v}%`}
              width={36}
            />
            <ReferenceLine y={50} stroke={COLOR_BORDER_STRONG} strokeDasharray="2 4" />
            <ReferenceLine
              y={panel.overallWrPct}
              stroke={panel.color}
              strokeOpacity={0.5}
              strokeDasharray="6 4"
            />
            <Tooltip
              cursor={{ stroke: COLOR_ACCENT, strokeDasharray: "3 3" }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0].payload as PanelPoint;
                const rows = [];
                if (p.winRatePct != null) {
                  rows.push({
                    key: "period",
                    label: "Win rate",
                    value: `${p.winRatePct}% · ${p.total} game${
                      p.total === 1 ? "" : "s"
                    }`,
                  });
                }
                if (p.rollingPct != null) {
                  rows.push({
                    key: "rolling",
                    label: "Rolling",
                    value: `${p.rollingPct}%`,
                  });
                }
                if (!rows.length) return null;
                return (
                  <ChartTooltip
                    header={`${panel.label} · ${formatTick(String(label), true)}`}
                    rows={rows}
                  />
                );
              }}
            />
            <Line
              type="linear"
              dataKey="winRatePct"
              stroke={panel.color}
              strokeOpacity={0.35}
              strokeWidth={1.25}
              dot={{ r: 1.5, strokeWidth: 0, fill: panel.color, fillOpacity: 0.4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="rollingPct"
              stroke={panel.color}
              strokeWidth={2.4}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function shapeMaps(
  points: MapPoint[],
  tz: string,
  topN: number,
  rollWindow: number,
) {
  const totals = new Map<string, number>();
  let grandTotal = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const p of points) {
    const t = p.total || 0;
    totals.set(p.key, (totals.get(p.key) || 0) + t);
    grandTotal += t;
    const date = localDateKey(p.bucket, tz);
    if (date && t > 0) {
      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;
    }
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
  const dates = new Set<string>();
  for (const p of points) {
    const d = localDateKey(p.bucket, tz);
    if (d) dates.add(d);
  }
  const sortedDates = [...dates].sort();
  const byKey = new Map<string, MapPoint>();
  for (const p of points) {
    const d = localDateKey(p.bucket, tz);
    if (!d) continue;
    byKey.set(`${d}|${p.key}`, p);
  }
  const panels = top.map(([mapKey, mapTotal], idx) => {
    let wins = 0;
    const seriesRaw: Array<Omit<PanelPoint, "rollingPct">> = [];
    for (const d of sortedDates) {
      const p = byKey.get(`${d}|${mapKey}`);
      if (p && p.total > 0) {
        wins += p.wins;
        seriesRaw.push({
          date: d,
          wins: p.wins,
          losses: p.losses,
          total: p.total,
          winRatePct: Math.round((p.wins / p.total) * 100),
        });
      } else {
        seriesRaw.push({
          date: d,
          wins: 0,
          losses: 0,
          total: 0,
          winRatePct: null,
        });
      }
    }
    const series = withRolling(seriesRaw, rollWindow);
    const overallWr = mapTotal > 0 ? wins / mapTotal : 0;
    const overallWrPct = Math.round(overallWr * 100);
    const recentDelta = computeRecentDelta(seriesRaw, overallWrPct);
    return {
      label: mapKey,
      series,
      totalGames: mapTotal,
      totalWins: wins,
      overallWrPct,
      recentDelta,
      // Per-map line colour follows the WR ramp on overall WR — a
      // map you reliably win on reads green, a bleeder reads red.
      color: wrColor(overallWr, mapTotal),
      idx,
    };
  });
  return {
    panels,
    totalGames: grandTotal,
    dateRange: { earliest, latest },
  };
}

function withRolling(
  series: Array<Omit<PanelPoint, "rollingPct">>,
  windowN: number,
): PanelPoint[] {
  const out: PanelPoint[] = [];
  const queue: Array<Omit<PanelPoint, "rollingPct">> = [];
  let wins = 0;
  let total = 0;
  for (const p of series) {
    if (p.total > 0) {
      queue.push(p);
      wins += p.wins;
      total += p.total;
      if (queue.length > windowN) {
        const dropped = queue.shift()!;
        wins -= dropped.wins;
        total -= dropped.total;
      }
    }
    const ready = queue.length === windowN && total > 0;
    out.push({
      ...p,
      rollingPct: ready ? Math.round((wins / total) * 100) : null,
    });
  }
  return out;
}

function computeRecentDelta(
  series: Array<Omit<PanelPoint, "rollingPct">>,
  overallWrPct: number,
): number | null {
  const played = series.filter((p) => p.total > 0);
  if (played.length < 4) return null;
  const tail = played.slice(Math.max(0, played.length - Math.ceil(played.length / 4)));
  let wins = 0;
  let total = 0;
  for (const p of tail) {
    wins += p.wins;
    total += p.total;
  }
  if (total === 0) return null;
  return Math.round((wins / total) * 100) - overallWrPct;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatTick(value: string, showYear: boolean): string {
  if (!value || value.length < 10) return value;
  const [y, m, d] = value.split("-");
  const monthIdx = Number.parseInt(m, 10) - 1;
  const dayN = Number.parseInt(d, 10);
  if (Number.isNaN(monthIdx) || monthIdx < 0 || monthIdx > 11) return value;
  const month = MONTHS[monthIdx];
  if (showYear) return `${month} '${y.slice(2)}`;
  return `${month} ${dayN}`;
}
