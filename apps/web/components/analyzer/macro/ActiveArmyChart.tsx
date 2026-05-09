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
import type { LeakItem } from "./MacroBreakdownPanel.types";
import {
  buildLayout,
  nearestPriorPoint,
  type ChartLayout,
  type SeriesPoint,
} from "./activeArmyLayout";
import {
  AccessibleLeakTable,
  ChartTooltip,
  Grid,
  HoverCrosshair,
  LeakBands,
  LeakMarkers,
  Legend,
  Lines,
  XAxis,
  YAxisLabels,
  type ActiveArmyLeakWindow,
  type HoverState,
} from "./ActiveArmyChartParts";

export type { ActiveArmyLeakWindow } from "./ActiveArmyChartParts";

/**
 * Single hover dispatch — the chart emits these to the parent so the
 * parent can manage sticky-vs-transient hover state. Mouse moves are
 * transient ("hover"); touch/pen taps are sticky ("tap"). A
 * "mouse-leave" only fires for true mouse pointers, so finger lifts
 * never clear the locked time.
 */
export type HoverEvent =
  | { type: "hover"; time: number }
  | { type: "tap"; time: number }
  | { type: "leave" };

export interface ActiveArmyChartProps {
  /**
   * Pre-built per-tick series for the local player. Each SeriesPoint
   * carries army value, worker count, AND the alive unit composition
   * at that tick. The parent (``MacroChartSection``) builds the
   * series once and threads it to both this chart and the
   * ``CompositionSnapshot`` roster, so the tooltip's army number and
   * the roster header's "Army NNN" are guaranteed to come from the
   * same SeriesPoint at the same hover time.
   */
  mySeries: SeriesPoint[];
  /** Opponent series — may be empty when no opp samples were extracted. */
  oppSeries: SeriesPoint[];
  gameLengthSec?: number;
  /** Leak collection — drives vertical markers along the time axis. */
  leaks: LeakItem[];
  /** Time-span windows (supply blocks, opp leak windows, etc.) drawn
   *  as translucent vertical bands behind the chart lines. Empty when
   *  the macro engine didn't surface windows for this game. */
  leakWindows?: ActiveArmyLeakWindow[];
  /** Opponent's leak windows — rendered with a distinct tone. */
  oppLeakWindows?: ActiveArmyLeakWindow[];
  /** Stable id of the highlighted leak — receives an emphasised marker. */
  highlightedKey?: string | null;
  /** Hovered game-time second — when set, the crosshair locks here. */
  hoveredTime?: number | null;
  /** Callback fired for every hover/tap/leave event. */
  onHover?: (event: HoverEvent) => void;
  /** Display name of the local player (for the tooltip header). */
  myName?: string | null;
  /** Display name of the opponent (for the tooltip header). */
  oppName?: string | null;
}

/**
 * Active Army & Workers chart — interactive SVG renderer.
 *
 * Hover behaviour mirrors sc2replaystats: a vertical crosshair tracks
 * the cursor exactly (no snap-jump), dots highlight each side's value
 * at the nearest sample, and a floating tooltip lists army value
 * (Σ minerals + gas of all non-worker units) and worker count for
 * both players. The hovered time is lifted to the parent so the
 * unit-composition snapshot below the chart stays in sync.
 *
 * Touch/pen taps lock the crosshair via the parent's sticky state —
 * users don't have to keep a finger pressed to read the values.
 *
 * Army series is derived from the same hybrid source the snapshot
 * uses (unit_timeline preferred, build-order fallback with
 * timeline-derived deaths), so the chart and the roster's "Army N"
 * header always agree at every tick. Older slim payloads (no
 * timeline, no build_order) fall back to a fighting-supply heuristic
 * so the line still renders.
 *
 * Sub-components for the Grid, X/Y axes, line paths, hover crosshair,
 * tooltip, and leak markers/bands live in
 * ``ActiveArmyChartParts.tsx`` to keep this file under the 800-line
 * cap. The chart owns layout/hover orchestration; the parts file owns
 * the per-layer SVG rendering.
 */
export function ActiveArmyChart({
  mySeries,
  oppSeries,
  gameLengthSec,
  leaks,
  leakWindows,
  oppLeakWindows,
  highlightedKey,
  hoveredTime = null,
  onHover,
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
    () => buildLayout(mySeries, oppSeries, gameLengthSec),
    [mySeries, oppSeries, gameLengthSec],
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

  /**
   * Map a pointer event into a game-time second within the plot area.
   *
   * The overlay <rect> spans viewBox coords [plotLeft, plotLeft+innerW]
   * — its CSS bounding rect maps to that exact range, so the cursor
   * fraction within the rect equals the fraction along the time axis
   * (0…maxT). preserveAspectRatio is "none" so the CSS-to-time mapping
   * is uniform.
   */
  const timeFromPointer = useCallback(
    (e: ReactPointerEvent<SVGRectElement>): number | null => {
      if (!layout) return null;
      const overlay = overlayRef.current;
      if (!overlay) return null;
      const rect = overlay.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const f = (e.clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(layout.maxT, f * layout.maxT));
    },
    [layout],
  );

  const dispatchPointer = useCallback(
    (e: ReactPointerEvent<SVGRectElement>, isDown: boolean) => {
      if (!onHover) return;
      const t = timeFromPointer(e);
      if (t == null) return;
      // Mouse pointers stay transient (clears on leave). Touch and pen
      // are sticky — a tap or drag locks the crosshair so the user
      // doesn't have to keep their finger pressed against the screen.
      if (e.pointerType === "mouse") {
        onHover({ type: "hover", time: t });
        return;
      }
      // For touch/pen, only the initial pointer-down (and subsequent
      // pointer-moves while the contact is active) emit taps. We
      // don't get a separate "tap end" — the parent keeps the lock.
      if (isDown || e.buttons || e.pressure > 0) {
        onHover({ type: "tap", time: t });
      } else {
        // bare-hover from a stylus that supports it — keep transient
        onHover({ type: "hover", time: t });
      }
    },
    [onHover, timeFromPointer],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<SVGRectElement>) => {
      dispatchPointer(e, false);
    },
    [dispatchPointer],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<SVGRectElement>) => {
      dispatchPointer(e, true);
    },
    [dispatchPointer],
  );

  const handlePointerLeave = useCallback(
    (e: ReactPointerEvent<SVGRectElement>) => {
      if (!onHover) return;
      // Only mouse leaves clear the hover. Touch lifts must NOT clear
      // — that's how we get the lock-on-tap behaviour on mobile.
      if (e.pointerType === "mouse") {
        onHover({ type: "leave" });
      }
    },
    [onHover],
  );

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
          <LeakBands layout={layout} windows={leakWindows} tone="me" />
          <LeakBands layout={layout} windows={oppLeakWindows} tone="opp" />
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
            style={{ touchAction: "none", cursor: onHover ? "crosshair" : "default" }}
            onPointerMove={onHover ? handlePointerMove : undefined}
            onPointerLeave={onHover ? handlePointerLeave : undefined}
            onPointerDown={onHover ? handlePointerDown : undefined}
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

function computeHoverPoints(
  layout: ChartLayout,
  hoveredTime: number | null | undefined,
): HoverState | null {
  if (typeof hoveredTime !== "number" || !Number.isFinite(hoveredTime)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(layout.maxT, hoveredTime));
  // Use ``nearestPriorPoint`` so the tooltip never reads from a
  // FUTURE sample. A hover at t=945 with samples at 930 and 960
  // snaps to 930, not 960 — without this, the worker count and army
  // number could leak post-hover state into the locked tooltip and
  // diverge from the roster (which also uses nearestPriorPoint).
  const my = nearestPriorPoint(layout.mySeries, clamped);
  const opp = nearestPriorPoint(layout.oppSeries, clamped);
  // Snap the SAMPLE indicator to whichever side has the LATER prior
  // sample (so a hover that spans a my-only or opp-only tick still
  // lands on the most-recently-rendered sample). Keep the vertical
  // crosshair at the exact cursor position so it tracks the mouse.
  const candidates: number[] = [];
  if (my) candidates.push(my.t);
  if (opp) candidates.push(opp.t);
  const t = candidates.length
    ? candidates.reduce((best, cand) => (cand > best ? cand : best), 0)
    : clamped;
  return {
    t,
    xView: layout.xOf(t),
    xMouseView: layout.xOf(clamped),
    my,
    opp,
  };
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
