"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Period } from "@/lib/timeseries";
import { mechanicsGeometry, mechanicsPoints, MECHANICS_METRICS, type MechanicsBucket, type MechanicsMetric } from "@/lib/mechanicsTrend";

export type MechanicsReference = { value: number; label: string };
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

/** Fixed calendar positions, straight observed segments and visible sample
 * counts. Missing metrics and missing periods always interrupt the line. */
export function MacroTrendChart({ series, metric = "macro", bucket = "week", reference = null }: { series: Period[]; metric?: MechanicsMetric; bucket?: MechanicsBucket; reference?: MechanicsReference | null }) {
  const plot = useRef<HTMLDivElement>(null), labelId = useId();
  const [width, setWidth] = useState(640), [selected, setSelected] = useState("");
  useEffect(() => {
    const resize = () => { const size = plot.current?.getBoundingClientRect().width; if (size) setWidth(Math.max(240, size)); };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (plot.current) observer?.observe(plot.current);
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, []);
  const points = useMemo(() => mechanicsPoints(series, metric, bucket), [series, metric, bucket]);
  const line = mechanicsGeometry(points, metric, reference?.value ?? null, width);
  const current = points.find(point => point.date === selected) ?? points.at(-1);
  const name = MECHANICS_METRICS[metric].label;
  if (!points.some(point => point.value !== null)) return <p className="py-8 text-caption text-text-muted">No measured {name.toLowerCase()} in these periods. Missing measurements stay empty.</p>;
  return <figure className="space-y-3" aria-labelledby={labelId}>
    <div ref={plot} className="min-w-0">
      <svg role="img" aria-label={`${name} by calendar ${bucket}. Hollow points have fewer than five measured games or an unknown sample count.`} viewBox={`0 0 ${width} 220`} className="h-[220px] w-full" data-testid="mechanics-trend-chart">
        {[0, .5, 1].map(fraction => <g key={fraction}><line x1={44} x2={width - 20} y1={line.y(line.upper * fraction)} y2={line.y(line.upper * fraction)} stroke="rgb(var(--border))" strokeDasharray="3 3" /><text x={36} y={line.y(line.upper * fraction) + 4} textAnchor="end" fill="rgb(var(--text-dim))" fontSize={11}>{number(line.upper * fraction)}</text></g>)}
        {reference ? <line data-testid="mechanics-reference" x1={44} x2={width - 20} y1={line.y(reference.value)} y2={line.y(reference.value)} stroke="rgb(var(--warning))" strokeWidth={1.5} strokeDasharray="5 4" /> : null}
        <path d={line.path} fill="none" stroke="rgb(var(--accent))" strokeWidth={2} data-testid="mechanics-trend-line" />
        {points.filter(point => point.value !== null).map(point => <circle key={point.date} data-date={point.date} data-n={point.n ?? "unknown"} data-hollow={String(point.hollow)} cx={line.x(point.time)} cy={line.y(point.value!)} r={point.date === current?.date ? 5 : 4} stroke="rgb(var(--accent))" strokeWidth={2} fill={point.hollow ? "rgb(var(--bg-surface))" : "rgb(var(--accent))"} onClick={() => setSelected(point.date)}><title>{point.date}: {number(point.value!)} · {point.n === null ? "sample count unavailable" : `${point.n} measured games`}</title></circle>)}
        <text x={44} y={214} fill="rgb(var(--text-dim))" fontSize={11}>{points[0].date}</text><text x={width - 20} y={214} textAnchor="end" fill="rgb(var(--text-dim))" fontSize={11}>{points.at(-1)!.date}</text>
      </svg>
    </div>
    <div className="flex flex-wrap items-center gap-2"><label htmlFor={`${labelId}-period`} className="text-micro text-text-muted">Inspect period</label><select id={`${labelId}-period`} value={current?.date ?? ""} onChange={event => setSelected(event.target.value)} className="min-h-11 max-w-full rounded-md border border-border bg-bg-surface px-2 text-caption">{points.map(point => <option key={point.date} value={point.date}>{point.date}</option>)}</select><p className="text-caption text-text" aria-live="polite">{current?.value === null ? "Not measured" : current ? number(current.value!) : "—"} · {current?.n == null ? "sample count unavailable" : `${current.n} measured ${current.n === 1 ? "game" : "games"}`}</p></div>
    <figcaption id={labelId} className="space-y-1 text-micro text-text-muted"><p>Average per calendar {bucket}. Hollow points: fewer than 5 measured games, or a count unavailable in older data. Gaps remain unmeasured; games without this metric do not lower the average.</p>{reference ? <p className="text-warning">Dashed line: {reference.label}, {number(reference.value)}. A population comparison, not a personal target.</p> : null}</figcaption>
  </figure>;
}
