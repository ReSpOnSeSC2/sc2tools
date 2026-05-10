"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/Card";
import { wrColor, wrRamp } from "@/lib/format";
import {
  decidedOnly,
  mapPeriodGrid,
  type H2HGame,
  type MapPeriodRow,
  type SplitMode,
} from "@/lib/h2hSeries";

type Props = {
  chronoGames: H2HGame[];
  split: SplitMode;
  onSplitChange: (next: SplitMode) => void;
  onSelectMap: (map: string | null) => void;
  selectedMap: string | null;
  presetLong: string;
  opponentName: string;
};

const LOW_N_THRESHOLD = 2;

/**
 * View 3 — Map & Period Heatmap.
 *
 * Splits the chronological games array into two equal halves (or
 * three equal thirds), then rolls up by map. Each cell shows
 * wins-losses on the top line and WR% below, tinted by `wrColor()`.
 * Clicking a row label filters the AllGamesTable below by map.
 */
export function MapPeriodHeatmap({
  chronoGames,
  split,
  onSplitChange,
  onSelectMap,
  selectedMap,
  presetLong,
  opponentName,
}: Props) {
  const decidedCount = useMemo(() => decidedOnly(chronoGames).length, [chronoGames]);
  const [showLowN, setShowLowN] = useState(false);
  const grid = useMemo(
    () => mapPeriodGrid(chronoGames, split),
    [chronoGames, split],
  );

  const minN = split === "halves" ? 6 : 9;
  if (decidedCount < minN) {
    return (
      <div className="space-y-4">
        <SplitToggle split={split} onSplitChange={onSplitChange} decidedCount={decidedCount} />
        <EmptyState
          title="Not enough games yet"
          sub={`Not enough games for a ${
            split === "halves" ? "halves" : "thirds"
          } split in ${presetLong} — need at least ${minN} decided games against ${opponentName}.`}
        />
      </div>
    );
  }

  const visibleRows = grid.rows.filter((r) => showLowN || r.total >= LOW_N_THRESHOLD);
  const hiddenLowNCount = grid.rows.length - visibleRows.length;
  const figcaption = buildFigcaption({
    opponent: opponentName,
    presetLong,
    split,
    rows: visibleRows,
  });

  return (
    <figure
      className="m-0 space-y-3"
      style={{ touchAction: "pan-y" }}
      aria-label="Map performance heatmap"
    >
      <figcaption className="sr-only">{figcaption}</figcaption>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SplitToggle split={split} onSplitChange={onSplitChange} decidedCount={decidedCount} />
        <div className="flex items-center gap-3 text-caption">
          {hiddenLowNCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowLowN((v) => !v)}
              className="min-h-[44px] rounded-md border border-border px-3 py-2 text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {showLowN
                ? `Hide low-sample maps (${hiddenLowNCount})`
                : `Show low-sample maps (${hiddenLowNCount})`}
            </button>
          ) : null}
          {selectedMap ? (
            <button
              type="button"
              onClick={() => onSelectMap(null)}
              className="inline-flex min-h-[44px] items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span aria-hidden>×</span>
              {selectedMap}
            </button>
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-bg-elevated/40">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-text-dim">
            <tr>
              <th className="sticky left-0 bg-bg-elevated px-3 py-2 text-left">Map</th>
              {grid.columns.map((c) => (
                <th key={c} className="px-3 py-2 text-center">
                  {c}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Trend</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <HeatmapRow
                key={row.map}
                row={row}
                isSelected={selectedMap === row.map}
                onSelectMap={onSelectMap}
              />
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function HeatmapRow({
  row,
  isSelected,
  onSelectMap,
}: {
  row: MapPeriodRow;
  isSelected: boolean;
  onSelectMap: (map: string | null) => void;
}) {
  const isLowN = row.total < LOW_N_THRESHOLD;
  const trend = row.trendDeltaPct;
  const trendGlyph = trend == null ? "—" : trend >= 5 ? "▲" : trend <= -5 ? "▼" : "▬";
  const trendStrong = trend != null && Math.abs(trend) >= 10;
  const trendClass = !trendStrong
    ? "text-text-dim"
    : trend! > 0
      ? "text-success"
      : "text-danger";
  return (
    <tr
      className={[
        "border-t border-border/60",
        isSelected ? "bg-accent/10" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <th
        scope="row"
        className="sticky left-0 bg-bg-elevated/40 px-2 py-1 text-left"
      >
        <button
          type="button"
          onClick={() => onSelectMap(isSelected ? null : row.map)}
          className="inline-flex min-h-[44px] w-full items-center gap-2 rounded px-2 py-1 text-left text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-pressed={isSelected}
          aria-label={
            isSelected
              ? `Clear ${row.map} filter`
              : `Filter games table to ${row.map}`
          }
        >
          <span className="truncate font-medium">{row.map}</span>
          {isLowN ? (
            <span
              className="ml-auto rounded-full border border-border px-1.5 text-[9px] uppercase tracking-wider text-text-dim"
              title="Low sample (< 2 games)"
            >
              low-n
            </span>
          ) : null}
        </button>
      </th>
      {row.cells.map((cell, idx) => (
        <td key={idx} className="px-2 py-1 text-center">
          <HeatCell
            wins={cell.wins}
            losses={cell.losses}
            total={cell.total}
            winRate={cell.winRate}
          />
        </td>
      ))}
      <td className="px-3 py-1 text-right">
        <span
          className={`inline-flex items-center gap-1 tabular-nums ${trendClass}`}
          aria-label={
            trend == null
              ? "No trend"
              : trend > 0
                ? `Improving ${trend} percentage points`
                : trend < 0
                  ? `Regressing ${Math.abs(trend)} percentage points`
                  : "Flat"
          }
        >
          <span aria-hidden>{trendGlyph}</span>
          {trend == null ? "" : `${trend > 0 ? "+" : ""}${trend}%`}
        </span>
      </td>
    </tr>
  );
}

function HeatCell({
  wins,
  losses,
  total,
  winRate,
}: {
  wins: number;
  losses: number;
  total: number;
  winRate: number;
}) {
  if (total === 0) {
    return <span className="text-text-dim">—</span>;
  }
  const tint = wrColor(winRate, total);
  const ramp = wrRamp(winRate);
  const bg = `rgba(${ramp[0]}, ${ramp[1]}, ${ramp[2]}, ${total < 3 ? 0.18 : 0.28})`;
  return (
    <span
      className="inline-flex flex-col items-center justify-center rounded px-2 py-1 min-w-[60px]"
      style={{ background: bg, color: tint }}
      title={`${wins}-${losses} (${total} games)`}
    >
      <span className="text-[11px] font-semibold tabular-nums">
        {wins}-{losses}
      </span>
      <span className="text-[10px] tabular-nums">
        {Math.round(winRate * 100)}%
      </span>
    </span>
  );
}

function SplitToggle({
  split,
  onSplitChange,
  decidedCount,
}: {
  split: SplitMode;
  onSplitChange: (next: SplitMode) => void;
  decidedCount: number;
}) {
  const thirdsDisabled = decidedCount < 9;
  return (
    <div
      role="radiogroup"
      aria-label="Period split"
      className="inline-flex rounded-md border border-border bg-bg-elevated/60 p-0.5"
    >
      <ToggleButton
        active={split === "halves"}
        onClick={() => onSplitChange("halves")}
        label="Halves"
      />
      <ToggleButton
        active={split === "thirds"}
        onClick={() => !thirdsDisabled && onSplitChange("thirds")}
        label="Thirds"
        disabled={thirdsDisabled}
        title={
          thirdsDisabled
            ? "Need at least 9 decided games for a thirds split"
            : undefined
        }
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  disabled,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={[
        "min-h-[44px] rounded px-3 py-1 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "bg-accent/15 text-accent"
          : "text-text-muted hover:text-text",
        disabled ? "cursor-not-allowed opacity-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label}
    </button>
  );
}

function buildFigcaption(args: {
  opponent: string;
  presetLong: string;
  split: SplitMode;
  rows: MapPeriodRow[];
}): string {
  const top = args.rows.slice(0, 3).map((r) => `${r.map} ${r.total}g`).join(", ");
  return (
    `Map performance vs ${args.opponent} split into ${
      args.split === "halves" ? "two halves" : "three thirds"
    } in ${args.presetLong}. ${args.rows.length} maps shown. Top: ${top || "none"}.`
  );
}
