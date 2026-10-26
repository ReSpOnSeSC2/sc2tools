"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type { Period } from "@/lib/timeseries";
import { mechanicsGeometry, mechanicsPoints, MECHANICS_METRICS, type MechanicsBucket, type MechanicsMetric, type MechanicsPoint } from "@/lib/mechanicsTrend";
import { isLowSample, useChartKit } from "@/lib/charts/theme";
import { Select } from "@/components/ui/Select";
import { ChartFrame, type ChartTableColumn } from "./ChartFrame";

export type MechanicsReference = { value: number; label: string };
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

/** Calendar positions and observed gaps retain the existing metric geometry. */
export function MacroTrendChart({ series, metric = "macro", bucket = "week", reference = null }: { series: Period[]; metric?: MechanicsMetric; bucket?: MechanicsBucket; reference?: MechanicsReference | null }) {
  const kit = useChartKit();
  const [plot, setPlot] = useState<HTMLDivElement | null>(null), labelId = useId();
  const [width, setWidth] = useState(640), [selected, setSelected] = useState("");
  useEffect(() => {
    if (!plot) return;
    const resize = () => { const size = plot.getBoundingClientRect().width; if (size) setWidth(Math.max(240, size)); };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(plot); window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, [plot]);
  const points = useMemo(() => mechanicsPoints(series, metric, bucket), [series, metric, bucket]);
  const line = mechanicsGeometry(points, metric, reference?.value ?? null, width);
  const current = points.find(point => point.date === selected) ?? points.at(-1), name = MECHANICS_METRICS[metric].label;
  const columns: ChartTableColumn<MechanicsPoint>[] = [
    { key: "date", label: "Period", render: point => point.date },
    { key: "value", label: name, align: "right", render: point => point.value === null ? "Not measured" : number(point.value) },
    { key: "n", label: "Measured games", align: "right", render: point => point.n === null ? "Unavailable" : point.n.toLocaleString() },
  ];
  return <ChartFrame title={`${name} over time`} rows={points.some(point => point.value !== null) ? points : []} columns={columns}
    summary={`${name} by calendar ${bucket}, ${points.length} periods. Gaps stay unmeasured. Hollow points have fewer than 20 measurements or an unknown count.`}
    empty={<p className="py-8 text-caption text-text-muted">No measured {name.toLowerCase()} in these periods. Missing measurements stay empty.</p>}>
    <figure className="space-y-3" aria-labelledby={labelId}>
      <div ref={setPlot} className="min-w-0">
        <svg role="img" aria-label={`${name} by calendar ${bucket}. Hollow points have fewer than 20 measured games or an unknown sample count.`} viewBox={`0 0 ${width} 220`} className="h-[220px] w-full" data-testid="mechanics-trend-chart">
          {[0, .5, 1].map(fraction => <g key={fraction}><line x1={44} x2={width - 20} y1={line.y(line.upper * fraction)} y2={line.y(line.upper * fraction)} stroke={kit.grid} strokeDasharray="3 3" /><text x={36} y={line.y(line.upper * fraction) + 4} textAnchor="end" fill={kit.axis} fontSize={12}>{number(line.upper * fraction)}</text></g>)}
          {reference ? <line data-testid="mechanics-reference" x1={44} x2={width - 20} y1={line.y(reference.value)} y2={line.y(reference.value)} stroke={kit.tokens.warning} strokeWidth={1.5} strokeDasharray="5 4" /> : null}
          <path d={line.path} fill="none" stroke={kit.series[0]} strokeWidth={2} data-testid="mechanics-trend-line" />
          {points.filter(point => point.value !== null).map(point => <circle key={point.date} data-date={point.date} data-n={point.n ?? "unknown"} data-hollow={String(isLowSample(point.n))} cx={line.x(point.time)} cy={line.y(point.value!)} r={point.date === current?.date ? 5 : 4} stroke={kit.series[0]} strokeWidth={2} fill={isLowSample(point.n) ? kit.tokens.bgSurface : kit.series[0]} onClick={() => setSelected(point.date)}><title>{point.date}: {number(point.value!)} · {point.n === null ? "sample count unavailable" : `${point.n} measured games`}</title></circle>)}
          <text x={44} y={214} fill={kit.axis} fontSize={12}>{points[0]?.date}</text><text x={width - 20} y={214} textAnchor="end" fill={kit.axis} fontSize={12}>{points.at(-1)?.date}</text>
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-2"><label htmlFor={`${labelId}-period`} className="text-micro text-text-muted">Inspect period</label><Select id={`${labelId}-period`} value={current?.date ?? ""} onChange={event => setSelected(event.target.value)} className="max-w-full">{points.map(point => <option key={point.date} value={point.date}>{point.date}</option>)}</Select><p className="text-caption text-text" aria-live="polite">{current?.value === null ? "Not measured" : current ? number(current.value!) : "—"} · {current?.n == null ? "sample count unavailable" : `${current.n} measured ${current.n === 1 ? "game" : "games"}`}</p></div>
      <figcaption id={labelId} className="space-y-1 text-micro text-text-muted"><p>Average per calendar {bucket}. Hollow points: fewer than 20 measured games, or a count unavailable in older data. Gaps remain unmeasured; games without this metric do not lower the average.</p>{reference ? <p className="text-warning">Dashed line: {reference.label}, {number(reference.value)}. Brackets group replays by the opponent&apos;s recorded league, a proxy for opposition level. This compares a population median with your period averages.</p> : null}</figcaption>
    </figure>
  </ChartFrame>;
}
