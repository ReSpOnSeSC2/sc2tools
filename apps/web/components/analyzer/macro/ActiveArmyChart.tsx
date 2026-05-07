"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AlertCircle } from "lucide-react";
import { formatGameClock, leakKey } from "@/lib/macro";
import type {
  LeakItem,
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";
import {
  PAD_LEFT,
  PAD_TOP,
  Y_TICK_FRACTIONS,
  buildLayout,
  nearestPoint,
  type ChartLayout,
  type SeriesPoint,
} from "./activeArmyLayout";

export interface ActiveArmyChartProps {
  /** Player samples (food_used, food_workers, …). */
  samples: StatsEvent[];
  /** Opponent samples. May be empty when not extracted. */
  oppSamples: StatsEvent[];
  /** Optional unit-timeline (per-tick army composition). */
  unitTimeline?: UnitTimelineEntry[];
  gameLengthSec?: number;
  /** Leak collection — drives vertical markers along the time axis. */
  leaks: LeakItem[];
  /** Stable id of the highlighted leak — receives an emphasised marker. */
  highlightedKey?: string | null;
  /** Hovered game-time second — when set, the crosshair locks here. */
  hoveredTime?: number | null;
  /** Callback fired when the user moves the cursor over the plot area. */
  onHoverTime?: (t: number | null) => void;
  /** Display name of the local player (for the tooltip header). */
  myName?: string | null;
  /** Display name of the opponent (for the tooltip header). */
  oppName?: string | null;
}

const COLOR_AXIS = "rgb(var(--text-dim))";
const COLOR_GRID = "rgb(var(--border))";
const COLOR_YOU = "rgb(var(--success))";
const COLOR_OPP = "rgb(var(--danger))";
const COLOR_HIGHLIGHT = "rgb(var(--accent-cyan))";
const COLOR_LEAK = "rgb(var(--warning))";

/**
 * Active Army & Workers chart — interactive SVG renderer.
 *
 * Hover behaviour mirrors sc2replaystats: a vertical crosshair tracks
 * the cursor, dots highlight each side's value at the hovered tick,
 * and a floating tooltip lists army value (Σ minerals + gas of all
 * non-worker units) and worker count for both players. The hovered
 * time is also lifted to the parent so the unit-composition snapshot
 * below the chart can stay in sync.
 *
 * Falls back gracefully when the agent payload omits
 * ``unit_timeline`` (older replays): the army series is computed from
 * ``food_used × 8`` and the composition snapshot is hidden by the
 * parent. The chart still works, the tooltip just shows the same
 * fallback number.
 */
export function ActiveArmyChart({
  samples,
  oppSamples,
  unitTimeline,
  gameLengthSec,
  leaks,
  highlightedKey,
  hoveredTime = null,
  onHoverTime,
  myName,
  oppName,
}: ActiveArmyChartProps) {
  const chartId = useId();
  const overlayRef = useRef<SVGRectElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<
    { width: number; height: number } | null
  >(null);

  const layout = useMemo(
    () => buildLayout(samples, oppSamples, gameLengthSec, unitTimeline),
    [samples, oppSamples, gameLengthSec, unitTimeline],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<SVGRectElement>) => {
      if (!layout || !onHoverTime) return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      // Map CSS pixels back into the SVG viewBox coords. preserveAspect
      // is "none" so the x scale is uniform.
      const svgX = ((e.clientX - rect.left) / rect.width) * layout.width;
      const t = layout.tOfX(svgX);
      onHoverTime(Math.max(0, Math.min(layout.maxT, t)));
    },
    [layout, onHoverTime],
  );

  const handlePointerLeave = useCallback(() => {
    if (onHoverTime) onHoverTime(null);
  }, [onHoverTime]);

  if (!layout) {
    return <ChartEmptyState />;
  }

  const hoverPoints = computeHoverPoints(layout, hoveredTime);

  return (
    <figure className="space-y-2" aria-labelledby={`${chartId}-title`}>
      <figcaption
        id={`${chartId}-title`}
        className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted"
      >
        <span className="font-semibold uppercase tracking-wider text-text">
          Active Army &amp; Workers
        </span>
        <Legend />
      </figcaption>

      <div
        ref={containerRef}
        className="relative overflow-x-auto rounded-lg border border-border bg-bg-elevated"
      >
        <svg
          role="img"
          aria-label="Army value (mineral + gas) and worker count over game time, both players overlaid. Hover for details."
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          className="block h-[220px] w-full min-w-[320px] sm:h-[260px] sm:min-w-[480px]"
        >
          <Grid layout={layout} />
          <XAxis layout={layout} />
          <LeakMarkers
            layout={layout}
            leaks={leaks}
            highlightedKey={highlightedKey}
          />
          <Lines layout={layout} />
          {hoverPoints ? (
            <HoverCrosshair layout={layout} hover={hoverPoints} />
          ) : null}
          <YAxisLabels layout={layout} />
          <rect
            ref={overlayRef}
            x={layout.plotLeft}
            y={layout.plotTop}
            width={layout.innerW}
            height={layout.innerH}
            fill="transparent"
            style={{ touchAction: "none", cursor: onHoverTime ? "crosshair" : "default" }}
            onPointerMove={onHoverTime ? handlePointerMove : undefined}
            onPointerLeave={onHoverTime ? handlePointerLeave : undefined}
            onPointerDown={onHoverTime ? handlePointerMove : undefined}
            aria-hidden
          />
        </svg>
        {hoverPoints && containerSize ? (
          <ChartTooltip
            layout={layout}
            hover={hoverPoints}
            container={containerSize}
            myName={myName}
            oppName={oppName}
          />
        ) : null}
      </div>

      <AccessibleLeakTable leaks={leaks} highlightedKey={highlightedKey} />
    </figure>
  );
}

interface HoverState {
  t: number;
  /** Pixel x in SVG viewBox space. */
  xView: number;
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
}

function computeHoverPoints(
  layout: ChartLayout,
  hoveredTime: number | null | undefined,
): HoverState | null {
  if (typeof hoveredTime !== "number" || !Number.isFinite(hoveredTime)) {
    return null;
  }
  const my = nearestPoint(layout.mySeries, hoveredTime);
  const opp = nearestPoint(layout.oppSeries, hoveredTime);
  // Snap the crosshair to the nearest sample on EITHER side so the
  // dots line up exactly with the rendered points instead of floating
  // a few pixels off.
  const candidates: number[] = [];
  if (my) candidates.push(my.t);
  if (opp) candidates.push(opp.t);
  const t = candidates.length
    ? candidates.reduce((best, cand) =>
        Math.abs(cand - hoveredTime) < Math.abs(best - hoveredTime)
          ? cand
          : best
      )
    : hoveredTime;
  return { t, xView: layout.xOf(t), my, opp };
}

function ChartEmptyState() {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-bg-subtle p-4">
      <div className="inline-flex items-center gap-2 text-caption font-semibold text-accent-cyan">
        <AlertCircle className="h-4 w-4" aria-hidden />
        Chart samples unavailable
      </div>
      <p className="text-caption text-text-muted">
        The Active Army &amp; Workers chart needs the per-second sample stream
        from your SC2 agent. Re-run the agent or click Recompute to ask it
        to re-parse the replay file.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <Swatch color={COLOR_YOU} dashed={false} label="you army" />
      <Swatch color={COLOR_YOU} dashed label="you wkrs" />
      <Swatch color={COLOR_OPP} dashed={false} label="opp army" />
      <Swatch color={COLOR_OPP} dashed label="opp wkrs" />
      <Swatch color={COLOR_HIGHLIGHT} dashed label="leak" thin />
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

function Grid({ layout }: { layout: ChartLayout }) {
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

function YAxisLabels({ layout }: { layout: ChartLayout }) {
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

function XAxis({ layout }: { layout: ChartLayout }) {
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

function Lines({ layout }: { layout: ChartLayout }) {
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

function HoverCrosshair({
  layout,
  hover,
}: {
  layout: ChartLayout;
  hover: HoverState;
}) {
  return (
    <g aria-hidden>
      <line
        x1={hover.xView}
        y1={layout.plotTop}
        x2={hover.xView}
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

function ChartTooltip({
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

function LeakMarkers({
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

function AccessibleLeakTable({
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
