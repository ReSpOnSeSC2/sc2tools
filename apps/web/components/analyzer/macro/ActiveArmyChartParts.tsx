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
 * them shaded in the leader's colour, labelled "Supply Blocked" bands
 * and a dashed crosshair with point markers. With several metrics on,
 * each keeps the player colours and draws in its own line pattern on a
 * 0%–"Peak" axis, unshaded. The dark read-out card lives in
 * ``TimelineTooltip``. The layout is drawn 1:1 in CSS pixels, so font
 * sizes here are real pixel sizes.
 */

import { formatGameClock, leakKey } from "@/lib/macro";
import type { LeakItem } from "./MacroBreakdownPanel.types";
import type { ChartLayout, SeriesPoint } from "./activeArmyLayout";

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
      {layout.yTicks.map(({ y }) => {
        return (
          <line
            key={`grid-${y}`}
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
      {layout.yTicks.map(({ y, label }) =>
        label ? (
          <text
            key={`y-${y}`}
            x={layout.plotLeft - 6}
            y={y}
            dy="0.32em"
            textAnchor="end"
            fontSize={AXIS_FONT_PX}
            fill={COLOR_AXIS}
          >
            {label}
          </text>
        ) : null,
      )}
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

/**
 * One line per player per metric. Every opponent line is drawn first so
 * yours stay on top; with several metrics on, each metric's pair shares
 * its line pattern.
 */
export function SeriesLines({ layout }: { layout: ChartLayout }) {
  const lines = [
    ...layout.tracks.map((tr) => ({ key: `opp-${tr.metric.key}`, d: tr.oppPath, color: COLOR_OPP, tr })),
    ...layout.tracks.map((tr) => ({ key: `my-${tr.metric.key}`, d: tr.myPath, color: COLOR_YOU, tr })),
  ];
  return (
    <g>
      {lines.map(({ key, d, color, tr }) =>
        d ? (
          <path
            key={key}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={LINE_WIDTH}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={layout.indexed ? tr.metric.dash : undefined}
          />
        ) : null,
      )}
    </g>
  );
}

/**
 * The gap between the two lines of a lone metric, washed in the colour
 * of whoever leads at each moment: blue where your line is above the
 * opponent's, red where it is below. Crossings split cleanly because
 * each half is clipped at the opponent's line.
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

/** A point on every plotted line at the inspected sample. */
function hoverMarkers(
  layout: ChartLayout,
  hover: HoverState,
): Array<{ key: string; y: number; color: string }> {
  const out: Array<{ key: string; y: number; color: string }> = [];
  const sides = [
    { side: "opp", point: hover.opp, color: COLOR_OPP },
    { side: "my", point: hover.my, color: COLOR_YOU },
  ];
  for (const { side, point, color } of sides) {
    for (const tr of layout.tracks) {
      const v = point ? tr.metric.read(point) : null;
      if (v != null) out.push({ key: `${side}-${tr.metric.key}`, y: tr.yOf(v), color });
    }
  }
  return out;
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
