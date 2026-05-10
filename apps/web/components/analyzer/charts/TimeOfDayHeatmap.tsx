"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { wrRamp } from "@/lib/format";
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
// on mobile. The bucket boundaries are stable; only the rendered label
// is locale-aware (see formatHourBlock).
const HOUR_BLOCKS: ReadonlyArray<{ start: number; end: number }> = [
  { start: 0, end: 4 },
  { start: 4, end: 8 },
  { start: 8, end: 12 },
  { start: 12, end: 16 },
  { start: 16, end: 20 },
  { start: 20, end: 24 },
];

/**
 * Format a 4-hour block boundary for the heatmap column header.
 *
 * 24-hour locales: zero-padded numeric range, e.g. "08–12".
 * 12-hour locales: compact a/p meridiem so six columns fit on a phone
 * without overlapping. Both ends are suffixed when the block straddles
 * noon or midnight so "8a–12p" can't be misread as "8p–midnight"; when
 * both ends share a meridiem only the right side is suffixed.
 */
function formatHourBlock(start: number, end: number, hour12: boolean): string {
  if (!hour12) {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(start)}–${pad(end)}`;
  }
  const meridiem = (h: number) => (h < 12 || h === 24 ? "a" : "p");
  const display = (h: number) => {
    const m = h % 12;
    return m === 0 ? 12 : m;
  };
  const startMer = meridiem(start);
  const endMer = meridiem(end);
  if (startMer === endMer) {
    return `${display(start)}–${display(end)}${endMer}`;
  }
  return `${display(start)}${startMer}–${display(end)}${endMer}`;
}

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
  // Detect once: a `false` value here means the user's locale prefers
  // 24-hour clock (en-GB, de-DE, …); the labels switch to "08 – 12"
  // form. `Intl.DateTimeFormat()` reflects browser/OS locale settings.
  const hour12 = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().hour12 ?? true;
    } catch {
      return true;
    }
  }, []);
  const formattedBlocks = useMemo(
    () => HOUR_BLOCKS.map((b) => formatHourBlock(b.start, b.end, hour12)),
    [hour12],
  );
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
        {(() => {
          const apiTz = data.timezone || "UTC";
          if (apiTz === tz) {
            return (
              <>
                Times in your local timezone (
                <code className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[12px] text-text-muted">
                  {apiTz}
                </code>
                ).
              </>
            );
          }
          return (
            <>
              Times in{" "}
              <code className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[12px] text-text-muted">
                {apiTz}
              </code>{" "}
              (the API converted from your filters).
            </>
          );
        })()}
      </p>
      <div className="overflow-x-auto">
        <div className="inline-grid min-w-full" style={{ gridTemplateColumns: `auto repeat(${HOUR_BLOCKS.length}, minmax(0, 1fr))` }}>
          <div />
          {formattedBlocks.map((label, blockIdx) => (
            <div
              key={blockIdx}
              className="whitespace-nowrap px-1 pb-1 text-center text-[11px] tabular-nums tracking-wide text-text-dim"
            >
              {label}
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
                  label={`${day} ${formattedBlocks[blockIdx]}`}
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

  // Win-rate mode: hue ramps red→amber→green via the shared severe
  // ramp (30% = deep red, 65% = deep green). Intensity stays a volume
  // dial so a 1-0 cell doesn't blare at full saturation, but the floor
  // is high enough that low-volume cells still read as clearly tinted
  // instead of washing out to "dirty cream" against the light theme.
  const wrIntensity = empty ? 0 : 0.65 + Math.min(1, vol * 1.5) * 0.35;
  const volIntensity = empty ? 0 : 0.18 + vol * 0.7;

  const background = empty
    ? "rgba(31, 37, 51, 0.4)"
    : mode === "wr"
      ? wrColor(wr, wrIntensity)
      : `rgba(124, 140, 255, ${volIntensity.toFixed(3)})`;

  const tooltipText =
    cell.total === 0
      ? `${label}: no games`
      : `${label} • ${cell.wins} W – ${cell.losses} L • ${Math.round(wr * 100)}% win rate`;

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
  // Severe ramp clamped at 30%/65%: two-stop gradient through amber
  // so a 50/50 cell can't be mistaken for a winning cell. See
  // `wrRamp` in lib/format.ts.
  const [r, g, b] = wrRamp(rate);
  return `rgba(${r}, ${g}, ${b}, ${intensity.toFixed(3)})`;
}
