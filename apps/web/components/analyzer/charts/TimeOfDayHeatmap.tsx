"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { clientTimezone } from "@/lib/timeseries";

type HeatmapCell = {
  dow: number;
  hour: number;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type HeatmapResponse = {
  timezone: string;
  cells: HeatmapCell[];
  totalGames: number;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// Aggregate hours into 4-hour blocks so 7 rows × 6 columns fits cleanly
// on mobile without forcing horizontal scroll.
const HOUR_BLOCKS: ReadonlyArray<{ start: number; end: number; label: string }> = [
  { start: 0, end: 4, label: "12-4a" },
  { start: 4, end: 8, label: "4-8a" },
  { start: 8, end: 12, label: "8-12p" },
  { start: 12, end: 16, label: "12-4p" },
  { start: 16, end: 20, label: "4-8p" },
  { start: 20, end: 24, label: "8-12a" },
];

type CellAgg = {
  total: number;
  wins: number;
  losses: number;
};

/**
 * Day-of-week × hour-of-day heatmap. Cells are tinted by win-rate
 * (red → neutral → green) and sized by game count via opacity, so a
 * single 5-0 weekend blip doesn't dominate the picture the way a raw
 * red-green map would.
 *
 * Toggle between "Win rate" and "Volume" colour modes. Hovering a
 * cell shows the raw W-L counts.
 */
export function TimeOfDayHeatmap() {
  const { filters, dbRev } = useFilters();
  const tz = useMemo(() => clientTimezone(), []);
  const params = useMemo(() => ({ ...filters, tz }), [filters, tz]);
  const { data, isLoading } = useApi<HeatmapResponse>(
    `/v1/timeseries/day-hour${filtersToQuery(params)}#${dbRev}`,
  );
  const [mode, setMode] = useState<"wr" | "volume">("wr");

  const grid = useMemo(() => {
    /** @type {CellAgg[][]} */
    const out: CellAgg[][] = Array.from({ length: 7 }, () =>
      HOUR_BLOCKS.map(() => ({ total: 0, wins: 0, losses: 0 })),
    );
    if (!data || !Array.isArray(data.cells)) return out;
    for (const cell of data.cells) {
      if (
        !Number.isInteger(cell.dow) ||
        !Number.isInteger(cell.hour) ||
        cell.dow < 0 ||
        cell.dow > 6 ||
        cell.hour < 0 ||
        cell.hour > 23
      ) {
        continue;
      }
      const blockIdx = HOUR_BLOCKS.findIndex(
        (b) => cell.hour >= b.start && cell.hour < b.end,
      );
      if (blockIdx < 0) continue;
      const slot = out[cell.dow][blockIdx];
      slot.total += cell.total || 0;
      slot.wins += cell.wins || 0;
      slot.losses += cell.losses || 0;
    }
    return out;
  }, [data]);

  const maxTotal = useMemo(() => {
    let m = 0;
    for (const row of grid) for (const cell of row) if (cell.total > m) m = cell.total;
    return m;
  }, [grid]);

  if (isLoading) {
    return (
      <Card title="Performance by time of day">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (!data || data.totalGames === 0) {
    return (
      <Card title="Performance by time of day">
        <EmptyState
          title="No games to plot"
          sub="The day-of-week × hour heatmap fills in once you have a few games on record."
        />
      </Card>
    );
  }

  return (
    <Card
      title="Performance by time of day"
      right={
        <div className="flex items-center gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => setMode("wr")}
            className={[
              "rounded px-2 py-0.5",
              mode === "wr"
                ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                : "bg-bg-elevated text-text-muted hover:text-text",
            ].join(" ")}
          >
            Win rate
          </button>
          <button
            type="button"
            onClick={() => setMode("volume")}
            className={[
              "rounded px-2 py-0.5",
              mode === "volume"
                ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                : "bg-bg-elevated text-text-muted hover:text-text",
            ].join(" ")}
          >
            Volume
          </button>
        </div>
      }
    >
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Times shown in your local timezone ({data.timezone || "UTC"}).
      </p>
      <div className="overflow-x-auto">
        <div className="inline-grid min-w-full" style={{ gridTemplateColumns: `auto repeat(${HOUR_BLOCKS.length}, minmax(0, 1fr))` }}>
          <div />
          {HOUR_BLOCKS.map((b) => (
            <div
              key={b.label}
              className="px-1 pb-1 text-center text-[10px] uppercase tracking-wide text-text-dim"
            >
              {b.label}
            </div>
          ))}
          {DAY_LABELS.map((day, dowIdx) => (
            <div className="contents" key={day}>
              <div className="pr-2 text-right text-[11px] font-medium text-text-muted">
                {day}
              </div>
              {grid[dowIdx].map((cell, blockIdx) => (
                <HeatCell
                  key={`${dowIdx}-${blockIdx}`}
                  cell={cell}
                  mode={mode}
                  maxTotal={maxTotal}
                  label={`${day} · ${HOUR_BLOCKS[blockIdx].label}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <Legend mode={mode} maxTotal={maxTotal} />
    </Card>
  );
}

function HeatCell({
  cell,
  mode,
  maxTotal,
  label,
}: {
  cell: CellAgg;
  mode: "wr" | "volume";
  maxTotal: number;
  label: string;
}) {
  const wr = cell.total ? cell.wins / cell.total : 0;
  const vol = maxTotal ? cell.total / maxTotal : 0;
  const empty = cell.total === 0;

  // Win-rate mode: hue ramps red→amber→green, intensity scales with
  // sample size so a 1-0 cell doesn't blare out at the same intensity
  // as a 50-game cell.
  const wrIntensity = empty ? 0 : 0.25 + Math.min(1, vol * 1.5) * 0.55;
  const volIntensity = empty ? 0 : 0.18 + vol * 0.7;

  const background = empty
    ? "rgba(31, 37, 51, 0.4)"
    : mode === "wr"
      ? wrColor(wr, wrIntensity)
      : `rgba(124, 140, 255, ${volIntensity.toFixed(3)})`;

  const tooltipText =
    cell.total === 0
      ? `${label}: no games`
      : `${label}: ${cell.wins}W-${cell.losses}L (${Math.round(wr * 100)}% WR)`;

  return (
    <div
      className="m-0.5 flex aspect-square items-center justify-center rounded text-[10px] font-semibold tabular-nums text-text"
      style={{ background }}
      title={tooltipText}
      aria-label={tooltipText}
    >
      <span className={empty ? "text-text-dim" : "text-text"}>
        {empty ? "·" : cell.total}
      </span>
    </div>
  );
}

function Legend({
  mode,
  maxTotal,
}: {
  mode: "wr" | "volume";
  maxTotal: number;
}) {
  if (mode === "wr") {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-text-dim">
        <span>WR ramp:</span>
        <span className="rounded px-1.5 py-0.5" style={{ background: wrColor(0.2, 0.7), color: "#fff" }}>
          ≤30%
        </span>
        <span className="rounded px-1.5 py-0.5" style={{ background: wrColor(0.45, 0.7), color: "#0b0d12" }}>
          ~45%
        </span>
        <span className="rounded px-1.5 py-0.5" style={{ background: wrColor(0.7, 0.7), color: "#0b0d12" }}>
          ≥65%
        </span>
        <span className="ml-2">· cell number = games played</span>
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-text-dim">
      <span>Volume ramp:</span>
      <span
        className="rounded px-1.5 py-0.5 text-text"
        style={{ background: "rgba(124, 140, 255, 0.18)" }}
      >
        few
      </span>
      <span
        className="rounded px-1.5 py-0.5 text-text"
        style={{ background: "rgba(124, 140, 255, 0.5)" }}
      >
        avg
      </span>
      <span
        className="rounded px-1.5 py-0.5 text-white"
        style={{ background: "rgba(124, 140, 255, 0.88)" }}
      >
        peak
      </span>
      <span className="ml-2">
        · {maxTotal > 0 ? `peak = ${maxTotal} game${maxTotal === 1 ? "" : "s"}` : ""}
      </span>
    </div>
  );
}

function wrColor(rate: number, intensity: number): string {
  // Two-stop ramp: red (0%) → amber (50%) → green (100%).
  let r: number;
  let g: number;
  let b: number;
  if (rate <= 0.5) {
    const t = Math.max(0, rate / 0.5);
    r = lerp(255, 230, t);
    g = lerp(107, 180, t);
    b = lerp(107, 80, t);
  } else {
    const t = Math.min(1, (rate - 0.5) / 0.5);
    r = lerp(230, 62, t);
    g = lerp(180, 192, t);
    b = lerp(80, 122, t);
  }
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${intensity.toFixed(3)})`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
