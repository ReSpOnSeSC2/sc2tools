"use client";

import { useId } from "react";

export interface RadarAxis {
  key: string;
  label: string;
  /** A measured value on a 0–100 scale. Missing evidence stays null. */
  value: number | null;
  detail?: string;
}

export function radarValue(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value)) : null;
}

/** Dependency-free SVG also works in OBS and narrow dossier modals. */
export function RadarChart({ label, axes, color = "#b99aff", compact = false }: {
  label: string; axes: RadarAxis[]; color?: string; compact?: boolean;
}) {
  const id = useId();
  if (axes.length < 3) return <p style={{ color: "#aab5cb", fontSize: 12 }}>Not enough dimensions to chart.</p>;
  const cx = 180, cy = 142, radius = 91;
  const point = (index: number, scale: number) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / axes.length;
    return { x: cx + Math.cos(angle) * radius * scale, y: cy + Math.sin(angle) * radius * scale };
  };
  const values = axes.map((axis) => radarValue(axis.value));
  const complete = values.every((value) => value !== null);
  const hasEvidence = values.some((value) => value !== null);
  const polygon = (scale: number) => axes.map((_, index) => {
    const p = point(index, scale); return `${p.x},${p.y}`;
  }).join(" ");
  return (
    <svg viewBox="0 0 360 286" role="img" aria-labelledby={`${id}-title`} aria-describedby={`${id}-desc`}
      style={{ width: "100%", height: "auto", maxHeight: compact ? 235 : 300, display: "block", overflow: "visible" }}>
      <title id={`${id}-title`}>{label}</title>
      <desc id={`${id}-desc`}>
        {axes.map((axis, index) => `${axis.label}: ${values[index] === null ? "unavailable" : `${Math.round(values[index]!)} of 100`}${axis.detail ? `. ${axis.detail}` : ""}`).join("; ")}
        {!complete ? ". Missing values are not plotted." : ""}
      </desc>
      <g aria-hidden="true">
        {[0.25, 0.5, 0.75, 1].map((scale) => (
          <polygon key={scale} points={polygon(scale)} fill={scale === 1 ? "#ffffff03" : "none"} stroke="#b6c2dd" strokeOpacity={scale === 1 ? 0.3 : 0.13} />
        ))}
        {axes.map((axis, index) => {
          const p = point(index, 1);
          return <line key={axis.key} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#b6c2dd" strokeOpacity={0.14} />;
        })}
        {complete ? <polygon data-testid="radar-area" points={values.map((value, index) => {
          const p = point(index, value! / 100); return `${p.x},${p.y}`;
        }).join(" ")} fill={color} fillOpacity={0.21} stroke={color} strokeWidth={2} strokeLinejoin="round" /> :
          values.map((value, index) => {
            const next = (index + 1) % values.length;
            if (value === null || values[next] === null) return null;
            const a = point(index, value / 100), b = point(next, values[next]! / 100);
            return <line key={axes[index].key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={2} />;
          })}
        {axes.map((axis, index) => {
          const anchor = point(index, 1.32), value = values[index];
          const p = value === null ? null : point(index, value / 100);
          const words = axis.label.split(" ");
          const lines = axis.label.length > 12 && words.length > 1
            ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")]
            : [axis.label];
          return <g key={axis.key}>
            {p ? <circle data-testid="radar-point" cx={p.x} cy={p.y} r={3.5} fill={color} stroke="#1b2132" strokeWidth={1.5} /> : null}
            <text x={anchor.x} y={anchor.y - (lines.length - 1) * 7} textAnchor="middle" fill="#c5cde0" fontFamily="inherit" fontSize={compact ? 16 : 11} fontWeight={600} letterSpacing="0.4">
              {lines.map((line, i) => <tspan key={i} x={anchor.x} dy={i ? 13 : 0}>{line.toUpperCase()}</tspan>)}
              <tspan x={anchor.x} dy={18} fill={value === null ? "#8490a8" : color} fontSize={compact ? 18 : 13} fontWeight={800}>{value === null ? "—" : Math.round(value)}</tspan>
            </text>
          </g>;
        })}
        {!hasEvidence ? <text x={cx} y={cy + 4} textAnchor="middle" fill="#aab5cb" fontFamily="inherit" fontSize={12}>Awaiting replays</text> : null}
      </g>
    </svg>
  );
}
