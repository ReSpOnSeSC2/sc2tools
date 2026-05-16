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
  ReferenceDot,
  ReferenceLine,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone, localDateKey } from "@/lib/timeseries";

type MmrPoint = {
  bucket: string;
  openMmr: number;
  closeMmr: number;
  minMmr: number;
  maxMmr: number;
  wins: number;
  losses: number;
  total: number;
};

type MmrResponse = {
  interval: "day" | "week" | "month";
  points: MmrPoint[];
  peak: { bucket: string; mmr: number } | null;
  trough: { bucket: string; mmr: number } | null;
  latest: { bucket: string; mmr: number } | null;
};

const COLOR_ACCENT = "#7c8cff";
const COLOR_SUCCESS = "#3ec07a";
const COLOR_DANGER = "#ff6b6b";
const COLOR_GRID = "#1f2533";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_BG_SURFACE = "#11141b";

/**
 * MMR progression over time.
 *
 * Renders the closing MMR per bucket as a smooth line with a soft
 * gradient fill; the bucket's min/max define a translucent band so
 * volatile periods read at a glance. Peak / trough / current markers
 * sit on top with subtle labels, and a stat row above the chart
 * shows the three numbers explicitly for quick scanning.
 *
 * The chart shares the global bucket choice from TrendsTab and
 * reuses every filter (since/until/race/opp_race/map/mmr range).
 */
export function MmrProgressionChart({
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
  const { data, isLoading } = useApi<MmrResponse>(
    `/v1/timeseries/mmr${filtersToQuery(params)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    if (!data || !Array.isArray(data.points)) return [];
    return data.points.map((p) => ({
      date: localDateKey(p.bucket, tz),
      close: p.closeMmr,
      min: p.minMmr,
      max: p.maxMmr,
      band: [p.minMmr, p.maxMmr] as [number, number],
      games: p.total,
      wins: p.wins,
      losses: p.losses,
    }));
  }, [data, tz]);

  const yDomain = useMemo(() => computeYDomain(rows), [rows]);

  const peakKey = data?.peak ? localDateKey(data.peak.bucket, tz) : null;
  const troughKey = data?.trough ? localDateKey(data.trough.bucket, tz) : null;
  const latestKey = data?.latest ? localDateKey(data.latest.bucket, tz) : null;

  if (isLoading) {
    return (
      <Card title="MMR progression">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (!rows.length) {
    return (
      <Card title="MMR progression">
        <EmptyState
          title="No MMR data yet"
          sub="Once your replays carry MMR (most ladder games do), this chart will trace your climb."
        />
      </Card>
    );
  }

  return (
    <Card title="MMR progression">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Closing MMR per {bucket} · shaded band = min/max within the bucket ·
        markers highlight peak, trough, and most recent.
      </p>
      <MmrHeadline data={data} />
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 24, bottom: 4, left: 4 }}
          >
            <defs>
              <linearGradient id="mmrFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_ACCENT} stopOpacity={0.32} />
                <stop offset="100%" stopColor={COLOR_ACCENT} stopOpacity={0} />
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
              domain={yDomain}
              width={52}
              tickMargin={4}
              tickFormatter={(v: number) => v.toLocaleString()}
            />
            {data?.latest ? (
              <ReferenceLine
                y={data.latest.mmr}
                stroke={COLOR_ACCENT}
                strokeOpacity={0.35}
                strokeDasharray="4 4"
              />
            ) : null}
            <Tooltip
              cursor={{ stroke: COLOR_ACCENT, strokeDasharray: "3 3" }}
              contentStyle={{
                background: COLOR_BG_SURFACE,
                border: `1px solid ${COLOR_GRID}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => {
                if (name === "close") return [value.toLocaleString(), "Closing MMR"];
                if (name === "band") return [null, null];
                return [value, name];
              }}
            />
            <Area
              type="monotone"
              dataKey="band"
              stroke="none"
              fill={COLOR_ACCENT}
              fillOpacity={0.12}
              isAnimationActive={false}
              connectNulls
              activeDot={false}
              legendType="none"
            />
            <Area
              type="monotone"
              dataKey="close"
              stroke="none"
              fill="url(#mmrFill)"
              isAnimationActive={false}
              activeDot={false}
              legendType="none"
            />
            <Line
              type="monotone"
              dataKey="close"
              stroke={COLOR_ACCENT}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5, fill: COLOR_ACCENT, stroke: COLOR_BG_SURFACE, strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {peakKey && data?.peak ? (
              <ReferenceDot
                x={peakKey}
                y={data.peak.mmr}
                r={5}
                fill={COLOR_SUCCESS}
                stroke={COLOR_BG_SURFACE}
                strokeWidth={2}
                isFront
              />
            ) : null}
            {troughKey && data?.trough ? (
              <ReferenceDot
                x={troughKey}
                y={data.trough.mmr}
                r={5}
                fill={COLOR_DANGER}
                stroke={COLOR_BG_SURFACE}
                strokeWidth={2}
                isFront
              />
            ) : null}
            {latestKey && data?.latest ? (
              <ReferenceDot
                x={latestKey}
                y={data.latest.mmr}
                r={5}
                fill={COLOR_ACCENT}
                stroke={COLOR_BG_SURFACE}
                strokeWidth={2}
                isFront
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function MmrHeadline({ data }: { data: MmrResponse | undefined }) {
  if (!data) return null;
  const items: Array<{
    label: string;
    value: string;
    sub?: string;
    color: string;
  }> = [];
  if (data.latest) {
    items.push({
      label: "Current",
      value: data.latest.mmr.toLocaleString(),
      color: COLOR_ACCENT,
    });
  }
  if (data.peak) {
    const delta = data.latest ? data.latest.mmr - data.peak.mmr : 0;
    items.push({
      label: "Peak",
      value: data.peak.mmr.toLocaleString(),
      sub: data.latest ? `${delta >= 0 ? "+" : ""}${delta} vs now` : undefined,
      color: COLOR_SUCCESS,
    });
  }
  if (data.trough) {
    const delta = data.latest ? data.latest.mmr - data.trough.mmr : 0;
    items.push({
      label: "Trough",
      value: data.trough.mmr.toLocaleString(),
      sub: data.latest ? `${delta >= 0 ? "+" : ""}${delta} vs now` : undefined,
      color: COLOR_DANGER,
    });
  }
  return (
    <div className="mb-3 grid grid-cols-3 gap-2 sm:max-w-md">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-lg border border-border bg-bg-elevated/60 px-3 py-2"
        >
          <div className="text-[10px] uppercase tracking-wider text-text-dim">
            {it.label}
          </div>
          <div
            className="mt-0.5 text-lg font-semibold tabular-nums"
            style={{ color: it.color }}
          >
            {it.value}
          </div>
          {it.sub ? (
            <div className="text-[10px] tabular-nums text-text-dim">{it.sub}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Tight Y-domain that pads ~5% above/below the extremes so the line
 * doesn't hug the chart edges, but never lets the range collapse so
 * far that a 20-MMR swing looks like a cliff. Falls back to "auto"
 * when the series is empty (the empty-state already short-circuits
 * before we ever reach here, but the guard keeps the type honest).
 */
function computeYDomain(rows: Array<{ min: number; max: number }>): [number, number] | undefined {
  if (!rows.length) return undefined;
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    if (r.min < lo) lo = r.min;
    if (r.max > hi) hi = r.max;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  const range = Math.max(hi - lo, 80);
  const pad = Math.max(20, Math.round(range * 0.08));
  return [Math.max(0, Math.floor((lo - pad) / 10) * 10), Math.ceil((hi + pad) / 10) * 10];
}
