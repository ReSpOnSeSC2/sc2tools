"use client";

/**
 * SVG sub-components for ``ActiveArmyChart``. Pulled out so the main
 * chart file stays under the 800-line cap. Each component is a leaf
 * renderer — they take ``layout`` (the projection helpers built by
 * ``activeArmyLayout.buildLayout``) plus their own narrow inputs and
 * draw a single layer of the chart. No state, no effects — pure SVG.
 *
 * The look: light horizontal grid, compact "5.0k" value labels, one
 * solid line per player (you blue, opponent red) with the gap between
 * them shaded in the leader's colour, labelled "Supply Blocked" bands,
 * a dashed crosshair with point markers, and a dark tooltip. The layout
 * is drawn 1:1 in CSS pixels, so font sizes here are real pixel sizes.
 */

import { formatGameClock, leakKey } from "@/lib/macro";
import type { LeakItem } from "./MacroBreakdownPanel.types";
import type { ChartLayout, SeriesPoint } from "./activeArmyLayout";
import {
  describeMetric,
  formatAxisValue,
  metricLead,
} from "./timelineMetrics";

export const COLOR_AXIS = "rgb(var(--text-dim))";
export const COLOR_GRID = "rgb(var(--border))";
export const COLOR_YOU = "rgb(var(--player-you))";
export const COLOR_OPP = "rgb(var(--player-opp))";
export const COLOR_INK = "rgb(var(--text))";
export const COLOR_HIGHLIGHT = "rgb(var(--accent-cyan))";
export const COLOR_LEAK = "rgb(var(--warning))";

const AXIS_FONT_PX = 11;
const LINE_WIDTH = 2.25;
/** Band labels need this much plot height to fit "Supply Blocked". */
const BAND_LABEL_MIN_PLOT_H = 110;
/** Closest two rotated band labels may sit, in pixels. */
const BAND_LABEL_GAP_PX = 13;

export interface ActiveArmySupplyBlockWindow {
  /** Window start (seconds, game time). */
  start: number;
  /** Window end (seconds, game time). */
  end: number;
  /** Total counted blocked seconds inside the window — see
   *  ``detect_supply_block_windows`` in macro_score.py. */
  blocked_sec?: number;
  /** Optional category — drives the band tone. */
  kind?: string;
}

/** Hover state internal to the chart: snapped samples + cursor x. */
export interface HoverState {
  /** Time of the latest sample at or before the cursor. */
  t: number;
  /** Cursor time, clamped to the game. */
  cursorT: number;
  xView: number;
  xMouseView: number;
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
}

export function Grid({ layout }: { layout: ChartLayout }) {
  return (
    <g aria-hidden>
      {layout.yTicks.map((v) => {
        const y = layout.yOf(v);
        return (
          <line
            key={`grid-${v}`}
            x1={layout.plotLeft}
            y1={y}
            x2={layout.plotRight}
            y2={y}
            stroke={COLOR_GRID}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        );
      })}
    </g>
  );
}

export function YAxisLabels({ layout }: { layout: ChartLayout }) {
  return (
    <g aria-hidden style={{ fontVariantNumeric: "tabular-nums" }}>
      {layout.yTicks.map((v) => (
        <text
          key={`y-${v}`}
          x={layout.plotLeft - 6}
          y={layout.yOf(v)}
          dy="0.32em"
          textAnchor="end"
          fontSize={AXIS_FONT_PX}
          fill={COLOR_AXIS}
        >
          {formatAxisValue(v)}
        </text>
      ))}
    </g>
  );
}

export function XAxis({ layout }: { layout: ChartLayout }) {
  const baseY = layout.plotBottom;
  return (
    <g aria-hidden style={{ fontVariantNumeric: "tabular-nums" }}>
      <line
        x1={layout.plotLeft}
        y1={baseY}
        x2={layout.plotRight}
        y2={baseY}
        stroke={COLOR_AXIS}
        strokeOpacity={0.45}
        shapeRendering="crispEdges"
      />
      {layout.xTickLabels.map(({ t, x, anchor }) => (
        <g key={`x-${t}`}>
          <line
            x1={x}
            y1={baseY}
            x2={x}
            y2={baseY + 4}
            stroke={COLOR_AXIS}
            strokeOpacity={0.6}
          />
          <text
            x={x}
            y={baseY + 16}
            textAnchor={anchor}
            fontSize={AXIS_FONT_PX}
            fill={COLOR_AXIS}
          >
            {formatGameClock(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** One line per player; yours is drawn last so it stays on top. */
export function SeriesLines({ layout }: { layout: ChartLayout }) {
  return (
    <g>
      {layout.oppPath ? (
        <path
          d={layout.oppPath}
          fill="none"
          stroke={COLOR_OPP}
          strokeWidth={LINE_WIDTH}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
      {layout.myPath ? (
        <path
          d={layout.myPath}
          fill="none"
          stroke={COLOR_YOU}
          strokeWidth={LINE_WIDTH}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
    </g>
  );
}

/**
 * The gap between the two lines, washed in the colour of whoever leads
 * at each moment: blue where your line is above the opponent's, red
 * where it is below. Crossings split cleanly because each half is
 * clipped at the opponent's line.
 */
export function LeadShading({
  layout,
  clipId,
}: {
  layout: ChartLayout;
  clipId: string;
}) {
  if (!layout.leadArea) return null;
  const halves = [
    { id: `${clipId}-lead`, region: layout.oppAbove, color: COLOR_YOU },
    { id: `${clipId}-trail`, region: layout.oppBelow, color: COLOR_OPP },
  ];
  return (
    <g aria-hidden>
      <defs>
        {halves.map(({ id, region }) => (
          <clipPath key={id} id={id}>
            <path d={region} />
          </clipPath>
        ))}
      </defs>
      {halves.map(({ id, color }) => (
        <path
          key={id}
          d={layout.leadArea}
          clipPath={`url(#${id})`}
          fill={color}
          fillOpacity={0.12}
        />
      ))}
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
        stroke={COLOR_INK}
        strokeOpacity={0.55}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
      {hoverMarkers(layout, hover).map((m) => (
        <circle
          key={m.key}
          cx={hover.xView}
          cy={m.y}
          r={4.5}
          fill={m.color}
          stroke="rgb(var(--bg-surface))"
          strokeWidth={2}
        />
      ))}
    </g>
  );
}

function hoverMarkers(
  layout: ChartLayout,
  hover: HoverState,
): Array<{ key: string; y: number; color: string }> {
  const out: Array<{ key: string; y: number; color: string }> = [];
  const oppV = hover.opp ? layout.metric.read(hover.opp) : null;
  const myV = hover.my ? layout.metric.read(hover.my) : null;
  if (oppV != null) out.push({ key: "opp", y: layout.yOf(oppV), color: COLOR_OPP });
  if (myV != null) out.push({ key: "my", y: layout.yOf(myV), color: COLOR_YOU });
  return out;
}

/**
 * The dark hover card: the clock, then each player's value (and whether
 * they were supply blocked at that moment).
 */
export function ChartTooltip({
  layout,
  hover,
  scaleX,
  myName,
  oppName,
  myBlocked,
  oppBlocked,
}: {
  layout: ChartLayout;
  hover: HoverState;
  /** CSS pixels per layout unit (1 once the chart has measured itself). */
  scaleX: number;
  myName: string;
  oppName: string;
  myBlocked: boolean;
  oppBlocked: boolean;
}) {
  const width = layout.width * scaleX < 420 ? 176 : 204;
  const cursorX = hover.xMouseView * scaleX;
  const containerW = layout.width * scaleX;
  // Beside the crosshair; flipped to its left near the right edge.
  const flip = cursorX + width + 16 > containerW;
  const left = flip ? Math.max(4, cursorX - width - 12) : cursorX + 12;
  const metric = layout.metric;
  const lead = metricLead(metric, hover.my, hover.opp);
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ left: `${left}px`, top: `${layout.plotTop + 4}px`, width: `${width}px` }}
      className="pointer-events-none absolute z-10 rounded-md bg-text px-3 py-2 text-micro text-bg shadow-lg"
    >
      <div className="text-caption font-bold tabular-nums">
        {formatGameClock(hover.t)}
      </div>
      <div aria-hidden className="my-1.5 h-px bg-bg/25" />
      <TooltipRow
        color={COLOR_YOU}
        name={myName}
        value={describeMetric(metric, hover.my)}
        blocked={myBlocked}
      />
      <TooltipRow
        color={COLOR_OPP}
        name={oppName}
        value={describeMetric(metric, hover.opp)}
        blocked={oppBlocked}
      />
      {lead != null ? (
        <div className="mt-1 border-t border-bg/25 pt-1 tabular-nums">
          {leadSentence(lead, myName, oppName)}
        </div>
      ) : null}
    </div>
  );
}

function leadSentence(lead: number, myName: string, oppName: string): string {
  if (lead === 0) return "Even";
  return `${lead > 0 ? myName : oppName} ahead by ${Math.abs(lead).toLocaleString()}`;
}

function TooltipRow({
  color,
  name,
  value,
  blocked,
}: {
  color: string;
  name: string;
  value: string;
  blocked: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="truncate font-medium">{name}</span>
        {blocked ? (
          <span className="flex-shrink-0 rounded bg-bg/20 px-1 font-semibold">
            blocked
          </span>
        ) : null}
      </span>
      <span className="flex-shrink-0 font-bold tabular-nums">{value}</span>
    </div>
  );
}

interface Band {
  key: string;
  x0: number;
  width: number;
  color: string;
}

function toBands(
  layout: ChartLayout,
  windows: ActiveArmySupplyBlockWindow[] | undefined,
  side: "me" | "opp",
): Band[] {
  if (!Array.isArray(windows)) return [];
  const out: Band[] = [];
  windows.forEach((w, idx) => {
    const start = Number(w.start);
    const end = Number(w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const lo = Math.max(0, Math.min(layout.maxT, Math.min(start, end)));
    const hi = Math.max(0, Math.min(layout.maxT, Math.max(start, end)));
    const x0 = layout.xOf(lo);
    out.push({
      key: `band-${side}-${idx}-${lo}`,
      x0,
      width: Math.max(2, layout.xOf(hi) - x0),
      color: side === "me" ? COLOR_YOU : COLOR_OPP,
    });
  });
  return out;
}

/**
 * Supply-block windows for both players as tinted bands, each titled
 * "Supply Blocked" down its length like sc2replaystats' annotations.
 * Labels that would overprint a neighbour are skipped; the band stays.
 */
export function SupplyBlockBands({
  layout,
  my,
  opp,
}: {
  layout: ChartLayout;
  my: ActiveArmySupplyBlockWindow[] | undefined;
  opp: ActiveArmySupplyBlockWindow[] | undefined;
}) {
  const bands = [...toBands(layout, my, "me"), ...toBands(layout, opp, "opp")]
    .sort((a, b) => a.x0 - b.x0);
  if (bands.length === 0) return null;
  const labelled = new Set<string>();
  if (layout.innerH >= BAND_LABEL_MIN_PLOT_H) {
    let lastX = -Infinity;
    for (const b of bands) {
      const x = b.x0 + b.width / 2;
      if (x - lastX < BAND_LABEL_GAP_PX) continue;
      labelled.add(b.key);
      lastX = x;
    }
  }
  return (
    <g aria-hidden>
      {bands.map((b) => (
        <rect
          key={b.key}
          x={b.x0}
          y={layout.plotTop}
          width={b.width}
          height={layout.plotBottom - layout.plotTop}
          fill={b.color}
          fillOpacity={0.14}
        />
      ))}
      {bands.map((b) => {
        if (!labelled.has(b.key)) return null;
        const x = b.x0 + b.width / 2;
        const y = layout.plotTop + 4;
        return (
          <text
            key={`${b.key}-label`}
            transform={`rotate(90 ${x} ${y})`}
            x={x}
            y={y}
            dy="0.35em"
            fontSize={10}
            fontWeight={600}
            fill={COLOR_AXIS}
          >
            Supply Blocked
          </text>
        );
      })}
    </g>
  );
}

/** True when ``t`` falls inside one of ``windows``. */
export function blockedAt(
  windows: ActiveArmySupplyBlockWindow[] | undefined,
  t: number,
): boolean {
  if (!Array.isArray(windows)) return false;
  return windows.some((w) => {
    const start = Number(w.start);
    const end = Number(w.end);
    return Number.isFinite(start) && Number.isFinite(end) && t >= start && t <= end;
  });
}

/**
 * Leaks as small markers along the time axis; the leak selected in
 * the list below also gets a full-height line.
 */
export function LeakMarkers({
  layout,
  leaks,
  highlightedKey,
}: {
  layout: ChartLayout;
  leaks: LeakItem[];
  highlightedKey?: string | null;
}) {
  const y = layout.plotBottom;
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
            {highlighted ? (
              <line
                x1={x}
                y1={layout.plotTop}
                x2={x}
                y2={y}
                stroke={COLOR_HIGHLIGHT}
                strokeWidth={2}
              />
            ) : null}
            <path
              d={`M${(x - 4).toFixed(1)},${y} L${(x + 4).toFixed(1)},${y} L${x.toFixed(1)},${y - 7} Z`}
              fill={highlighted ? COLOR_HIGHLIGHT : COLOR_LEAK}
              fillOpacity={highlighted ? 1 : 0.85}
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
  // The wrapper clips: ``sr-only`` on the table itself does not, because
  // a table grows to fit its cells and widened the page on phones.
  return (
    <div className="sr-only">
      <table>
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
    </div>
  );
}
