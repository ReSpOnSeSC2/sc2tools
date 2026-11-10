"use client";

import { useEffect, useId, useMemo, useState, type PointerEvent } from "react";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { ChartFrame, ChartLegend, type ChartTableColumn } from "@/components/analyzer/charts/ChartFrame";
import { useChartKit } from "@/lib/charts/theme";
import { computeXTicks, niceCeil, type SeriesPoint } from "@/components/analyzer/macro/activeArmyLayout";
import { formatAxisValue, formatMetricValue, formatSigned, timelineMetric, type TimelineMetricDef } from "@/components/analyzer/macro/timelineMetrics";
import { COMPARE_METRICS, metricDelta, pointAt } from "@/lib/gameCompare";
import { formatClock } from "@/lib/replayHud";
import type { CompareSide } from "./useCompareSide";

const HEIGHT = 170;
const PAD = { left: 42, right: 12, top: 10, bottom: 24 };
/** Table rows: one per this many seconds, so the table stays readable. */
const TABLE_STEP_SEC = 30;

type Row = { t: number; a: number | null; b: number | null; delta: number | null };

const valueAt = (metric: TimelineMetricDef, series: readonly SeriesPoint[], t: number) => {
  const point = pointAt(series, t);
  return point ? metric.read(point) : null;
};

function path(metric: TimelineMetricDef, series: readonly SeriesPoint[], x: (t: number) => number, y: (v: number) => number): string {
  let d = "";
  let open = false;
  for (const point of series) {
    const value = metric.read(point);
    if (value === null || !Number.isFinite(value)) { open = false; continue; }
    d += `${open ? "L" : "M"}${x(point.t).toFixed(1)} ${y(value).toFixed(1)}`;
    open = true;
  }
  return d;
}

function MetricChart({ metric, a, b, maxT, cursor, onCursor, colors }: {
  metric: TimelineMetricDef; a: readonly SeriesPoint[]; b: readonly SeriesPoint[]; maxT: number;
  cursor: number; onCursor: (t: number) => void; colors: { a: string; b: string; grid: string; axis: string };
}) {
  const [plot, setPlot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    if (!plot) return;
    const resize = () => { const size = plot.getBoundingClientRect().width; if (size) setWidth(Math.max(240, size)); };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(plot);
    return () => observer?.disconnect();
  }, [plot]);
  const peak = Math.max(metric.floor, ...[...a, ...b].map((point) => metric.read(point) ?? 0));
  const top = niceCeil(peak);
  const x = (t: number) => PAD.left + (Math.min(Math.max(t, 0), maxT) / maxT) * (width - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / top) * (HEIGHT - PAD.top - PAD.bottom);
  // Clock labels at least ~48 px apart, so a phone-width chart stays legible.
  const allTicks = computeXTicks(maxT);
  const every = Math.max(1, Math.ceil((allTicks.length * 48) / (width - PAD.left - PAD.right)));
  const ticks = allTicks.filter((_, index) => index % every === 0);
  const aValue = valueAt(metric, a, cursor);
  const bValue = valueAt(metric, b, cursor);
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const fraction = ((event.clientX - rect.left) / rect.width) * width;
    onCursor(Math.round(((fraction - PAD.left) / (width - PAD.left - PAD.right)) * maxT));
  };
  return (
    <div ref={setPlot} className="min-w-0">
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} className="h-[170px] w-full touch-pan-y" role="img"
        aria-label={`${metric.title}: game A ${formatMetricValue(aValue)}, game B ${formatMetricValue(bValue)} at ${formatClock(cursor)}`}
        onPointerMove={move} onPointerDown={move} data-testid={`compare-chart-${metric.key}`}>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(top * fraction)} y2={y(top * fraction)} stroke={colors.grid} strokeDasharray="3 3" />
            <text x={PAD.left - 6} y={y(top * fraction) + 4} textAnchor="end" fill={colors.axis} fontSize={12}>{formatAxisValue(top * fraction)}</text>
          </g>
        ))}
        {ticks.map((t) => <text key={t} x={x(t)} y={HEIGHT - 6} textAnchor="middle" fill={colors.axis} fontSize={12}>{formatClock(t)}</text>)}
        <path d={path(metric, a, x, y)} fill="none" stroke={colors.a} strokeWidth={2.25} data-testid={`compare-line-a-${metric.key}`} />
        <path d={path(metric, b, x, y)} fill="none" stroke={colors.b} strokeWidth={2.25} strokeDasharray="6 4" data-testid={`compare-line-b-${metric.key}`} />
        <line x1={x(cursor)} x2={x(cursor)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke={colors.axis} strokeWidth={1} />
        {aValue !== null ? <circle cx={x(cursor)} cy={y(aValue)} r={4} fill={colors.a} /> : null}
        {bValue !== null ? <circle cx={x(cursor)} cy={y(bValue)} r={4} fill="none" stroke={colors.b} strokeWidth={2} /> : null}
      </svg>
    </div>
  );
}

function sideNote(label: "A" | "B", side: CompareSide): string | null {
  if (side.macroState === "loading") return `Loading game ${label}'s timeline…`;
  if (side.macroState === "missing" || (side.macroState === "ready" && !side.series.length)) return `Game ${label} has no timeline data, so only the other game is drawn.`;
  return null;
}

/**
 * Workers, army value, income and supply for both games on one game
 * clock: A solid, B dashed, one cursor shared by all four charts (drag
 * across any chart or use the slider) with A − B at that moment. Two
 * columns on wide screens; stacked on phones.
 */
export function CompareTimelines({ a, b }: { a: CompareSide; b: CompareSide }) {
  const kit = useChartKit();
  const sliderId = useId();
  const maxT = Math.max(60, a.series.at(-1)?.t ?? 0, b.series.at(-1)?.t ?? 0);
  const [cursor, setCursor] = useState(() => Math.min(360, maxT));
  const t = Math.min(Math.max(0, cursor), maxT);
  const colors = { a: kit.series[0], b: kit.series[1] ?? kit.series[0], grid: kit.grid, axis: kit.axis };
  const metrics = useMemo(() => COMPARE_METRICS.map((key) => timelineMetric(key)), []);
  const notes = [sideNote("A", a), sideNote("B", b)].filter(Boolean) as string[];
  const errors = [["A", a], ["B", b]] as const;
  const nothing = !a.series.length && !b.series.length;
  return (
    <Card title="Timelines" data-testid="compare-timelines">
      <div className="space-y-4">
        {errors.map(([label, side]) => side.macroState === "error"
          ? <RequestError key={label} title={`Couldn't load game ${label}'s timeline`} error={side.macroError} onRetry={side.retryMacro} />
          : null)}
        {notes.map((note) => <p key={note} className="text-caption text-text-muted">{note}</p>)}
        {nothing ? null : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor={sliderId} className="text-caption font-semibold text-text">At {formatClock(t)}</label>
              <input id={sliderId} type="range" min={0} max={Math.ceil(maxT)} step={5} value={Math.round(t)}
                onChange={(event) => setCursor(Number(event.target.value))}
                aria-valuetext={`${formatClock(t)} of game time`} className="h-6 min-w-40 flex-1 cursor-pointer accent-current" />
              <ChartLegend items={[
                { key: "a", label: "Game A", color: colors.a },
                { key: "b", label: "Game B", color: colors.b, strokeDasharray: "6 4" },
              ]} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              {metrics.map((metric) => {
                const aValue = valueAt(metric, a.series, t);
                const bValue = valueAt(metric, b.series, t);
                const delta = metricDelta(aValue, bValue);
                const rows: Row[] = [];
                for (let s = 0; s <= maxT; s += TABLE_STEP_SEC) {
                  const ra = valueAt(metric, a.series, s), rb = valueAt(metric, b.series, s);
                  rows.push({ t: s, a: ra, b: rb, delta: metricDelta(ra, rb) });
                }
                const columns: ChartTableColumn<Row>[] = [
                  { key: "t", label: "Time", render: (row) => formatClock(row.t) },
                  { key: "a", label: "Game A", align: "right", render: (row) => formatMetricValue(row.a) },
                  { key: "b", label: "Game B", align: "right", render: (row) => formatMetricValue(row.b) },
                  { key: "d", label: "A − B", align: "right", render: (row) => (row.delta === null ? "—" : formatSigned(row.delta)) },
                ];
                return (
                  <ChartFrame key={metric.key} title={metric.label} showTitle rows={rows.some((row) => row.a !== null || row.b !== null) ? rows : []} columns={columns}
                    summary={`${metric.title} through both games, every ${TABLE_STEP_SEC} seconds: game A solid, game B dashed.`}
                    toolbar={
                      <p className="text-caption tabular-nums text-text-muted" aria-live="polite" data-testid={`compare-readout-${metric.key}`}>
                        A {formatMetricValue(aValue)} · B {formatMetricValue(bValue)} · Δ {delta === null ? "—" : formatSigned(delta)}
                      </p>
                    }>
                    <MetricChart metric={metric} a={a.series} b={b.series} maxT={maxT} cursor={t} onCursor={setCursor} colors={colors} />
                  </ChartFrame>
                );
              })}
            </div>
          </>
        )}
        {nothing && !notes.length && a.macroState !== "error" && b.macroState !== "error" ? (
          <p className="text-caption text-text-muted">Neither game has timeline data.</p>
        ) : null}
      </div>
    </Card>
  );
}
