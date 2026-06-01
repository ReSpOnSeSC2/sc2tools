"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone, localDateKey } from "@/lib/timeseries";

type MixPoint = {
  bucket: string;
  key: string;
  wins: number;
  losses: number;
  total: number;
};

type MixResponse = {
  interval: "day" | "week" | "month";
  points: MixPoint[];
};

type ChartRow = {
  date: string;
  total: number;
} & Record<string, number | string>;

const COLOR_GRID = "#1f2533";
const COLOR_TEXT_DIM = "#6b7280";
const OTHER_KEY = "__other";
const OTHER_LABEL = "Other";
const OTHER_COLOR = "#3a4252";

// Distinct, accessible palette tuned for the dark surface. Order is
// stable so the same series gets the same colour across re-renders.
const PALETTE = [
  "#7c8cff", // accent
  "#3ec07a", // success
  "#e6b450", // warning
  "#ff6b6b", // danger
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#fb923c", // orange
];

const TOP_N_OPTIONS = [4, 6, 8] as const;
const DEFAULT_TOP_N = 6;

type MixOverTimeChartProps = {
  /** Endpoint suffix under /v1/ — e.g. "timeseries/my-builds". */
  endpoint: string;
  /** Card title. */
  title: string;
  /** Short caption below the title (1 line). */
  caption: string;
  /** Bucket granularity, threaded from TrendsTab. */
  bucket: "day" | "week" | "month";
  /** Label for the "no data" empty state. */
  emptyTitle?: string;
  /** Sub-copy for the empty state. */
  emptySub?: string;
};

/**
 * 100% stacked-area "mix" chart.
 *
 * Generic on the categorical dimension — used by the "Your build
 * mix" and "Strategies you're facing" cards in the Trends tab.
 * Selects the top-N most-played categories over the visible window
 * (toggleable: 4/6/8) and rolls the remainder into a single
 * "Other" series so the chart never balloons past readable colour
 * palette size, even on accounts with hundreds of distinct values.
 *
 * Per-period shares — never raw counts — because the question this
 * chart answers is "how is the *composition* shifting?". A raw-
 * volume answer is already covered by the games-per-period bars at
 * the top of the tab.
 */
export function MixOverTimeChart({
  endpoint,
  title,
  caption,
  bucket,
  emptyTitle = "Not enough data to plot a mix yet",
  emptySub,
}: MixOverTimeChartProps) {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(
    () => ({ ...filters, interval: bucket, tz }),
    [filters, bucket, tz],
  );
  const { data, isLoading } = useApi<MixResponse>(
    `/v1/${endpoint}${filtersToQuery(params)}#${dbRev}`,
  );
  const [topN, setTopN] = useState<number>(DEFAULT_TOP_N);
  // Lifting the hovered/tapped bucket out of the floating tooltip
  // and into a dedicated panel below the chart was the only way to
  // make the breakdown legible on narrow mobile viewports — the
  // default tooltip is wider than the plot region once build labels
  // ("PvT - Phoenix into Robo") get involved and ends up covering
  // the very chart it's annotating.
  const [activeDate, setActiveDate] = useState<string | null>(null);

  const { rows, series, totalGames } = useMemo(
    () => shapeForChart(data?.points || [], tz, topN),
    [data, tz, topN],
  );

  // Default selection = most recent period, so the panel always has
  // something useful in it before the user interacts.
  const selectedRow = useMemo(() => {
    if (rows.length === 0) return null;
    if (activeDate) {
      const match = rows.find((r) => r.date === activeDate);
      if (match) return match;
    }
    return rows[rows.length - 1];
  }, [rows, activeDate]);

  const onChartMouseMove = useCallback(
    (state: { activeLabel?: string | number } | null) => {
      if (state && typeof state.activeLabel === "string") {
        setActiveDate(state.activeLabel);
      }
    },
    [],
  );
  const onChartMouseLeave = useCallback(() => setActiveDate(null), []);

  if (isLoading) {
    return (
      <Card title={title}>
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (rows.length === 0 || totalGames === 0) {
    return (
      <Card title={title}>
        <EmptyState title={emptyTitle} sub={emptySub} />
      </Card>
    );
  }

  return (
    <Card
      title={title}
      right={
        <TopNToggle value={topN} onChange={setTopN} />
      }
    >
      <p className="-mt-1 mb-3 text-caption text-text-dim">{caption}</p>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={rows}
            margin={{ top: 4, right: 12, bottom: 4, left: -4 }}
            stackOffset="expand"
            onMouseMove={onChartMouseMove}
            onMouseLeave={onChartMouseLeave}
          >
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
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              width={42}
            />
            {/*
             * Keep Recharts' cursor crosshair so hover position is
             * visible, but suppress the floating tooltip body — the
             * breakdown lives in <ActiveBreakdown> below the chart,
             * never overlapping the plot.
             */}
            <Tooltip
              cursor={{ stroke: "#7c8cff", strokeDasharray: "3 3" }}
              content={() => null}
              wrapperStyle={{ display: "none" }}
              isAnimationActive={false}
            />
            {series.map((s, idx) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stackId="mix"
                stroke={s.color}
                strokeWidth={1}
                fill={s.color}
                fillOpacity={0.78}
                isAnimationActive={false}
                name={s.label}
                style={{ filter: idx % 2 === 0 ? undefined : "saturate(1.05)" }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ActiveBreakdown
        row={selectedRow}
        series={series}
        isFollowingCursor={activeDate != null}
      />
      <Legend series={series} />
    </Card>
  );
}

/**
 * Per-period breakdown rendered below the chart. Replaces the
 * floating Recharts tooltip — on a narrow mobile viewport the
 * tooltip's natural width exceeds the chart's plot region and
 * covers the very area it's annotating. Hosting the breakdown in
 * a dedicated row keeps the picture readable on any screen and
 * makes the value visible at all times instead of only on hover.
 *
 * Idle state: shows the most recent period (so the panel is never
 * blank). Hover/tap state: shows whichever period the cursor is
 * over. The "Latest" / "Hovering" pill makes the source explicit.
 */
function ActiveBreakdown({
  row,
  series,
  isFollowingCursor,
}: {
  row: (ChartRow & Record<string, number | string>) | null;
  series: Array<{ key: string; label: string; color: string }>;
  isFollowingCursor: boolean;
}) {
  if (!row) return null;
  const total = (row.total as number) || 0;
  const entries = series
    .map((s) => ({ ...s, count: (row[s.key] as number) || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);
  return (
    <div className="mt-3 rounded-lg border border-border bg-bg-elevated/60 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="text-caption font-semibold text-text">{row.date}</span>
          <span
            className={[
              "rounded px-1.5 py-0.5 text-micro font-medium uppercase tracking-wider",
              isFollowingCursor
                ? "bg-accent/15 text-accent ring-1 ring-accent/30"
                : "bg-bg-elevated text-text-dim ring-1 ring-border",
            ].join(" ")}
          >
            {isFollowingCursor ? "Hovering" : "Latest period"}
          </span>
        </div>
        <span className="text-micro tabular-nums text-text-dim">
          {total} game{total === 1 ? "" : "s"}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="text-caption text-text-dim">No games in this period.</div>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => {
            const share = total > 0 ? e.count / total : 0;
            return (
              <li key={e.key} className="flex items-center gap-2 text-caption">
                <span
                  className="inline-block h-2.5 w-2.5 flex-none rounded-sm"
                  style={{ background: e.color }}
                />
                <span
                  className="min-w-0 flex-1 truncate text-text-muted"
                  title={e.label}
                >
                  {e.label}
                </span>
                <span className="flex-none tabular-nums text-text">
                  {Math.round(share * 100)}%
                </span>
                <span className="flex-none text-micro tabular-nums text-text-dim">
                  · {e.count}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TopNToggle({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-micro">
      <span className="text-text-dim">Top</span>
      {TOP_N_OPTIONS.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className={[
            "rounded px-2 py-0.5",
            value === n
              ? "bg-accent/20 text-accent ring-1 ring-accent/40"
              : "bg-bg-elevated text-text-muted hover:text-text",
          ].join(" ")}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

function Legend({
  series,
}: {
  series: Array<{ key: string; label: string; color: string; total: number }>;
}) {
  if (series.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-micro">
      {series.map((s) => (
        <span
          key={s.key}
          className="inline-flex items-center gap-1.5 text-text-muted"
          title={`${s.label} · ${s.total} games`}
        >
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: s.color }}
          />
          <span className="max-w-[160px] truncate">{s.label}</span>
          <span className="text-text-dim tabular-nums">· {s.total}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Collapse the raw (bucket, key, count) point cloud into a stacked-
 * area-friendly row set. Steps: collect totals per key, pick the
 * top N, fold the rest into "Other", emit one row per bucket with
 * counts on each series key.
 *
 * The output series colours come from a stable palette indexed by
 * the rank in the top-N list — same data always paints the same
 * colour across re-renders.
 */
function shapeForChart(
  points: MixPoint[],
  tz: string,
  topN: number,
): {
  rows: ChartRow[];
  series: Array<{ key: string; label: string; color: string; total: number }>;
  totalGames: number;
} {
  if (!points.length) return { rows: [], series: [], totalGames: 0 };
  const totals = new Map<string, number>();
  let grandTotal = 0;
  for (const p of points) {
    const t = p.total || 0;
    totals.set(p.key, (totals.get(p.key) || 0) + t);
    grandTotal += t;
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN);
  const topSet = new Set(top.map(([k]) => k));
  const hasOther = sorted.length > top.length;
  const otherTotal = hasOther
    ? sorted.slice(topN).reduce((acc, [, n]) => acc + n, 0)
    : 0;
  const series = top.map(([key, total], idx) => ({
    key,
    label: key,
    color: PALETTE[idx % PALETTE.length],
    total,
  }));
  if (hasOther) {
    series.push({
      key: OTHER_KEY,
      label: OTHER_LABEL,
      color: OTHER_COLOR,
      total: otherTotal,
    });
  }
  const rowsByDate = new Map<string, ChartRow>();
  for (const p of points) {
    const date = localDateKey(p.bucket, tz);
    if (!date) continue;
    let row = rowsByDate.get(date);
    if (!row) {
      row = { date, total: 0 };
      for (const s of series) row[s.key] = 0;
      rowsByDate.set(date, row);
    }
    const seriesKey = topSet.has(p.key) ? p.key : OTHER_KEY;
    if (row[seriesKey] === undefined) row[seriesKey] = 0;
    row[seriesKey] = (row[seriesKey] as number) + (p.total || 0);
    row.total = (row.total as number) + (p.total || 0);
  }
  const rows = [...rowsByDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  return { rows, series, totalGames: grandTotal };
}
