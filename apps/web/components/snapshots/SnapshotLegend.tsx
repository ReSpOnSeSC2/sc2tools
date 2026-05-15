"use client";

import {
  RIBBON_LOSER,
  RIBBON_WINNER,
  USER_LINE,
  OPP_LINE,
} from "./shared/colorScales";

// Compact one-row legend explaining the band chart conventions.
// Rendered alongside the chart cluster so users new to the page
// can decode the colors without hovering on individual elements.

export function SnapshotLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
      <Item label="Winners P25–P75" swatch={<Block fill={RIBBON_WINNER} />} />
      <Item label="Losers P25–P75" swatch={<Block fill={RIBBON_LOSER} />} />
      <Item label="You" swatch={<Stroke color={USER_LINE} />} />
      <Item label="Opponent" swatch={<Stroke color={OPP_LINE} dashed />} />
    </div>
  );
}

function Item({ label, swatch }: { label: string; swatch: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  );
}

function Block({ fill }: { fill: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-4 rounded-sm"
      style={{ background: fill }}
    />
  );
}

function Stroke({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <span aria-hidden className="inline-block h-0.5 w-5" style={{ background: color }}>
      {dashed ? (
        <span
          className="block h-full w-full"
          style={{
            backgroundImage: `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 7px)`,
          }}
        />
      ) : null}
    </span>
  );
}
