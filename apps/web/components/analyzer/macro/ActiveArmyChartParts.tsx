"use client";

/**
 * SVG sub-components for ``ActiveArmyChart``. Pulled out so the main
 * chart file stays under the 800-line cap. Each component is a leaf
 * renderer — they take ``layout`` (the projection helpers built by
 * ``activeArmyLayout.buildLayout``) plus their own narrow inputs and
 * draw a single layer of the chart. No state, no effects — pure SVG.
 *
 * Colours are exported so the parent can compose its own swatches and
 * tooltips against the same palette without re-declaring constants.
 */

import { formatGameClock, leakKey } from "@/lib/macro";
import type { LeakItem } from "./MacroBreakdownPanel.types";
import {
  PAD_TOP,
  Y_TICK_FRACTIONS,
  type ChartLayout,
  type SeriesPoint,
} from "./activeArmyLayout";

export const COLOR_AXIS = "rgb(var(--text-dim))";
export const COLOR_GRID = "rgb(var(--border))";
export const COLOR_YOU = "rgb(var(--success))";
export const COLOR_OPP = "rgb(var(--danger))";
export const COLOR_HIGHLIGHT = "rgb(var(--accent-cyan))";
export const COLOR_LEAK = "rgb(var(--warning))";

export interface ActiveArmyLeakWindow {
  /** Window start (seconds, game time). */
  start: number;
  /** Window end (seconds, game time). */
  end: number;
  /** Optional category — drives the band tone. */
  kind?: string;
}

/** Hover state internal to the chart: snapped sample + cursor x. */
export interface HoverState {
  t: number;
  xView: number;
  xMouseView: number;
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
}

export function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <Swatch color={COLOR_YOU} dashed={false} label="you army" />
      <Swatch color={COLOR_YOU} dashed label="you wkrs" />
      <Swatch color={COLOR_OPP} dashed={false} label="opp army" />
      <Swatch color={COLOR_OPP} dashed label="opp wkrs" />
      <Swatch color={COLOR_LEAK} dashed label="leak" thin />
      <BandSwatch color={COLOR_YOU} label="you blocks" />
      <BandSwatch color={COLOR_OPP} label="opp blocks" />
    </span>
  );
}

function BandSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="14" height="8" aria-hidden>
        <rect x="1" y="1" width="12" height="6" fill={color} fillOpacity="0.18" />
      </svg>
      <span className="text-text-muted">{label}</span>
    </span>
  );
}

function Swatch({
  color,
  dashed,
  label,
  thin = false,
}: {
  color: string;
  dashed: boolean;
  label: string;
  thin?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <svg width="14" height="6" aria-hidden>
        <line
          x1="1"
          y1="3"
          x2="13"
          y2="3"
          stroke={color}
          strokeWidth={thin ? 1 : 2}
          strokeDasharray={dashed ? "2 2" : ""}
        />
      </svg>
      <span className="text-text-muted">{label}</span>
    </span>
  );
}

export function Grid({ layout }: { layout: ChartLayout }) {
  return (
    <g aria-hidden>
      {Y_TICK_FRACTIONS.map((f) => {
        const y = PAD_TOP + (1 - f) * layout.innerH;
        return (
          <line
            key={`grid-${f}`}
            x1={layout.plotLeft}
            y1={y}
            x2={layout.plotRight}
            y2={y}
            stroke={COLOR_GRID}
            strokeOpacity={0.6}
            strokeDasharray="2 4"
          />
        );
      })}
    </g>
  );
}

export function YAxisLabels({ layout }: { layout: ChartLayout }) {
  return (
    <g aria-hidden>
      {Y_TICK_FRACTIONS.map((f) => {
        const y = PAD_TOP + (1 - f) * layout.innerH;
        return (
          <g key={`y-${f}`}>
            <text
              x={layout.plotLeft - 6}
              y={y + 3}
              textAnchor="end"
              fontSize="10"
              fill={COLOR_AXIS}
            >
              {Math.round(f * layout.armyMax)}
            </text>
            <text
              x={layout.plotRight + 6}
              y={y + 3}
              textAnchor="start"
              fontSize="10"
              fill={COLOR_AXIS}
            >
              {Math.round(f * layout.workerMax)}
            </text>
          </g>
        );
      })}
      <text
        x={layout.plotLeft - 6}
        y={PAD_TOP - 4}
        textAnchor="end"
        fontSize="9"
        fill={COLOR_AXIS}
      >
        army
      </text>
      <text
        x={layout.plotRight + 6}
        y={PAD_TOP - 4}
        textAnchor="start"
        fontSize="9"
        fill={COLOR_AXIS}
      >
        wkrs
      </text>
    </g>
  );
}

export function XAxis({ layout }: { layout: ChartLayout }) {
  const baseY = layout.plotBottom;
  return (
    <g aria-hidden>
      <line
        x1={layout.plotLeft}
        y1={baseY}
        x2={layout.plotRight}
        y2={baseY}
        stroke={COLOR_GRID}
      />
      {layout.xTicks.map((t) => (
        <g key={`x-${t}`}>
          <line
            x1={layout.xOf(t)}
            y1={baseY}
            x2={layout.xOf(t)}
            y2={baseY + 4}
            stroke={COLOR_AXIS}
            strokeOpacity={0.6}
          />
          <text
            x={layout.xOf(t)}
            y={baseY + 16}
            textAnchor="middle"
            fontSize="10"
            fill={COLOR_AXIS}
          >
            {formatGameClock(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

export function Lines({ layout }: { layout: ChartLayout }) {
  return (
    <g>
      {layout.oppWorker ? (
        <path
          d={layout.oppWorker}
          fill="none"
          stroke={COLOR_OPP}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      ) : null}
      {layout.myWorker ? (
        <path
          d={layout.myWorker}
          fill="none"
          stroke={COLOR_YOU}
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      ) : null}
      {layout.oppArmy ? (
        <path
          d={layout.oppArmy}
          fill="none"
          stroke={COLOR_OPP}
          strokeWidth={1.75}
        />
      ) : null}
      {layout.myArmy ? (
        <path
          d={layout.myArmy}
          fill="none"
          stroke={COLOR_YOU}
          strokeWidth={1.75}
        />
      ) : null}
    </g>
  );
}

export function HoverCrosshair({
  layout,
  hover,
}: {
  layout: ChartLayout;
  hover: HoverState;
}) {
  return (
    <g aria-hidden>
      <line
        x1={hover.xMouseView}
        y1={layout.plotTop}
        x2={hover.xMouseView}
        y2={layout.plotBottom}
        stroke={COLOR_HIGHLIGHT}
        strokeWidth={1}
        strokeOpacity={0.7}
      />
      {hover.my ? (
        <>
          <circle
            cx={hover.xView}
            cy={layout.yArmy(hover.my.army)}
            r={3}
            fill={COLOR_YOU}
            stroke="white"
            strokeWidth={1}
          />
          <circle
            cx={hover.xView}
            cy={layout.yWorker(hover.my.workers)}
            r={2.5}
            fill={COLOR_YOU}
            stroke="white"
            strokeWidth={0.8}
          />
        </>
      ) : null}
      {hover.opp ? (
        <>
          <circle
            cx={hover.xView}
            cy={layout.yArmy(hover.opp.army)}
            r={3}
            fill={COLOR_OPP}
            stroke="white"
            strokeWidth={1}
          />
          <circle
            cx={hover.xView}
            cy={layout.yWorker(hover.opp.workers)}
            r={2.5}
            fill={COLOR_OPP}
            stroke="white"
            strokeWidth={0.8}
          />
        </>
      ) : null}
    </g>
  );
}

export function ChartTooltip({
  layout,
  hover,
  container,
  myName,
  oppName,
}: {
  layout: ChartLayout;
  hover: HoverState;
  container: { width: number; height: number };
  myName?: string | null;
  oppName?: string | null;
}) {
  // Map the SVG hover x back to a CSS pixel position inside the
  // container so we can place the tooltip with absolute positioning.
  // CSS positioning beats inline SVG <foreignObject> for legibility
  // (clean wrapping, theme tokens, no scaled fonts).
  const cssX = (hover.xView / layout.width) * container.width;
  // Try to keep the tooltip on the cursor's right; flip when within
  // 180 px of the right edge so it doesn't clip.
  const TOOLTIP_W = 200;
  const flip = cssX + TOOLTIP_W + 16 > container.width;
  const left = flip ? Math.max(8, cssX - TOOLTIP_W - 12) : cssX + 12;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        left: `${left}px`,
        top: `8px`,
        width: `${TOOLTIP_W}px`,
        pointerEvents: "none",
      }}
      className="absolute z-10 rounded-md border border-border bg-bg-elevated/95 p-2 text-[11px] text-text shadow-lg backdrop-blur supports-[backdrop-filter]:bg-bg-elevated/85"
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-text-muted">
        <span className="font-semibold uppercase tracking-wider">
          {formatGameClock(hover.t)}
        </span>
        <span className="text-[10px]">army · workers</span>
      </div>
      <PlayerRow
        color={COLOR_YOU}
        name={myName?.trim() || "You"}
        army={hover.my?.army}
        workers={hover.my?.workers}
      />
      <PlayerRow
        color={COLOR_OPP}
        name={oppName?.trim() || "Opponent"}
        army={hover.opp?.army}
        workers={hover.opp?.workers}
      />
    </div>
  );
}

function PlayerRow({
  color,
  name,
  army,
  workers,
}: {
  color: string;
  name: string;
  army?: number;
  workers?: number;
}) {
  const armyTxt = typeof army === "number" ? Math.round(army).toLocaleString() : "—";
  const workersTxt = typeof workers === "number" ? String(Math.round(workers)) : "—";
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="h-2 w-2 flex-shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="truncate font-medium">{name}</span>
      </span>
      <span className="flex flex-shrink-0 items-baseline gap-1.5 tabular-nums">
        <span>{armyTxt}</span>
        <span className="text-text-dim">·</span>
        <span className="text-text-muted">{workersTxt}</span>
      </span>
    </div>
  );
}

export function LeakBands({
  layout,
  windows,
  tone,
}: {
  layout: ChartLayout;
  windows: ActiveArmyLeakWindow[] | undefined;
  tone: "me" | "opp";
}) {
  if (!Array.isArray(windows) || windows.length === 0) return null;
  const fill = tone === "me" ? COLOR_YOU : COLOR_OPP;
  return (
    <g aria-hidden>
      {windows.map((w, idx) => {
        const start = Number(w.start);
        const end = Number(w.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        const lo = Math.max(0, Math.min(layout.maxT, Math.min(start, end)));
        const hi = Math.max(0, Math.min(layout.maxT, Math.max(start, end)));
        const x0 = layout.xOf(lo);
        const x1 = layout.xOf(hi);
        const width = Math.max(2, x1 - x0);
        return (
          <rect
            key={`band-${tone}-${idx}-${lo}`}
            x={x0}
            y={layout.plotTop}
            width={width}
            height={layout.plotBottom - layout.plotTop}
            fill={fill}
            fillOpacity={0.08}
          />
        );
      })}
    </g>
  );
}

export function LeakMarkers({
  layout,
  leaks,
  highlightedKey,
}: {
  layout: ChartLayout;
  leaks: LeakItem[];
  highlightedKey?: string | null;
}) {
  return (
    <g aria-hidden>
      {leaks.map((leak, idx) => {
        if (typeof leak.time !== "number" || !Number.isFinite(leak.time)) {
          return null;
        }
        const id = leakKey(leak, idx);
        const highlighted = id === highlightedKey;
        const x = layout.xOf(Math.max(0, Math.min(layout.maxT, leak.time)));
        return (
          <g key={id}>
            <line
              x1={x}
              y1={layout.plotTop}
              x2={x}
              y2={layout.plotBottom}
              stroke={highlighted ? COLOR_HIGHLIGHT : COLOR_LEAK}
              strokeWidth={highlighted ? 1.5 : 1}
              strokeOpacity={highlighted ? 0.95 : 0.5}
              strokeDasharray={highlighted ? "" : "2 3"}
            />
            <circle
              cx={x}
              cy={layout.plotTop + 4}
              r={highlighted ? 3.5 : 2.5}
              fill={highlighted ? COLOR_HIGHLIGHT : COLOR_LEAK}
              fillOpacity={highlighted ? 1 : 0.7}
            />
          </g>
        );
      })}
    </g>
  );
}

export function AccessibleLeakTable({
  leaks,
  highlightedKey,
}: {
  leaks: LeakItem[];
  highlightedKey?: string | null;
}) {
  const timed = leaks.filter(
    (l) => typeof l.time === "number" && Number.isFinite(l.time),
  );
  if (timed.length === 0) return null;
  return (
    <table className="sr-only">
      <caption>Leak events plotted on the chart, ordered by game time.</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Leak</th>
          <th scope="col">Detail</th>
          <th scope="col">Highlighted</th>
        </tr>
      </thead>
      <tbody>
        {timed.map((leak, idx) => {
          const id = leakKey(leak, idx);
          return (
            <tr key={id}>
              <td>{formatGameClock(leak.time)}</td>
              <td>{leak.name || "Unnamed leak"}</td>
              <td>{leak.detail || ""}</td>
              <td>{id === highlightedKey ? "yes" : "no"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
