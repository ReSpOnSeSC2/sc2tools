"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
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
  LeadShading,
  LeakMarkers,
  SeriesLines,
  SupplyBlockBands,
  XAxis,
  YAxisLabels,
  blockedAt,
  type ActiveArmySupplyBlockWindow,
  type HoverState,
} from "./ActiveArmyChartParts";
import { MetricSwitch, TimelineSummary } from "./TimelineControls";
import {
  DEFAULT_TIMELINE_METRIC,
  type TimelineMetric,
} from "./timelineMetrics";

export type { ActiveArmySupplyBlockWindow } from "./ActiveArmyChartParts";

/**
 * Single hover dispatch — the chart emits these to the parent so the
 * parent can manage preview-vs-locked selection state. Mouse moves emit
 * "hover" and the parent retains the last value on "leave"; clicks,
 * taps and sideways touch drags lock the selection ("tap"). Scrolling
 * never emits a selection.
 */
export type HoverEvent =
  | { type: "hover"; time: number }
  | { type: "tap"; time: number }
  | { type: "leave" };

export interface ActiveArmyChartProps {
  /**
   * Pre-built per-tick series for the local player. Each SeriesPoint
   * carries army value, worker count, supply, collection rate AND the
   * alive unit composition at that tick. The parent
   * (``MacroChartSection``) builds the series once and threads it to
   * both this chart and the ``CompositionSnapshot`` roster, so the
   * tooltip's army number and the roster header's "Army NNN" are
   * guaranteed to come from the same SeriesPoint at the same time.
   */
  mySeries: SeriesPoint[];
  /** Opponent series — may be empty when no opp samples were extracted. */
  oppSeries: SeriesPoint[];
  gameLengthSec?: number;
  /** Leak collection — drives markers along the time axis. */
  leaks: LeakItem[];
  /** Per-window supply-block annotations for the local player, drawn
   *  as labelled bands behind the chart lines. Empty when the macro
   *  engine didn't surface windows for this game. */
  supplyBlockWindows?: ActiveArmySupplyBlockWindow[];
  /** Opponent's supply-block windows — rendered in the opponent colour. */
  oppSupplyBlockWindows?: ActiveArmySupplyBlockWindow[];
  /** Stable id of the highlighted leak — receives an emphasised marker. */
  highlightedKey?: string | null;
  /** Hovered game-time second — when set, the crosshair locks here. */
  hoveredTime?: number | null;
  /** True when a tap or click has pinned ``hoveredTime``. */
  locked?: boolean;
  /** Callback fired for every hover/tap/leave event. */
  onHover?: (event: HoverEvent) => void;
  /** Display name of the local player (for the tooltip header). */
  myName?: string | null;
  /** Display name of the opponent (for the tooltip header). */
  oppName?: string | null;
  /** Your race, for the metric switch's icons. */
  myRace?: string | null;
  /** Draw the supply-block bands (the host owns the on/off switch). */
  showSupplyBlocks?: boolean;
  /** Render the "Match timeline" caption (off when the host titles it). */
  showTitle?: boolean;
  /** Classes for the outer figure (e.g. sticky positioning). */
  className?: string;
}

/** Sideways travel, in pixels, before a touch drag scrubs the chart. */
const SCRUB_SLOP_PX = 8;

interface TouchGesture {
  id: number;
  x: number;
  y: number;
  scrubbing: boolean;
}

/**
 * Match timeline — interactive SVG chart.
 *
 * One metric at a time (army value, workers, supply, income), both
 * players overlaid in their colours with the gap between them shaded
 * for whoever leads, labelled supply-block bands, a dashed crosshair, a
 * dark tooltip and a "Game time | you | opponent" read-out underneath.
 * The hovered time is lifted to the parent so the unit roster below
 * stays in sync.
 *
 * The SVG is laid out at its measured pixel size, so it fills the
 * width of any screen without stretching text. Height comes from CSS.
 *
 * Mouse: moving previews a time; click locks it. Touch: tap locks a
 * time and a sideways drag scrubs it, while vertical drags scroll the
 * page (``touch-action: pan-y``) and never move the lock.
 *
 * Army values come from ``buildSeries`` (sc2reader's army value when
 * present, derived composition otherwise), so the chart and the
 * roster's "Army N" agree at every tick.
 */
export function ActiveArmyChart({
  mySeries,
  oppSeries,
  gameLengthSec,
  leaks,
  supplyBlockWindows,
  oppSupplyBlockWindows,
  highlightedKey,
  hoveredTime = null,
  locked = false,
  onHover,
  myName,
  oppName,
  myRace,
  showSupplyBlocks = true,
  showTitle = true,
  className = "",
}: ActiveArmyChartProps) {
  const chartId = useId();
  const clipId = `timeline-${chartId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const overlayRef = useRef<SVGRectElement | null>(null);
  const gesture = useRef<TouchGesture | null>(null);
  const [containerRef, size] = useElementSize();
  const [metric, setMetric] = useState<TimelineMetric>(DEFAULT_TIMELINE_METRIC);

  const layout = useMemo(
    () =>
      buildLayout(mySeries, oppSeries, gameLengthSec, {
        metric,
        width: size?.width,
        height: size?.height,
      }),
    [mySeries, oppSeries, gameLengthSec, metric, size],
  );

  /**
   * Map a pointer event into a game-time second within the plot area.
   * The overlay <rect> spans exactly the plot, so the cursor fraction
   * within its box is the fraction along the time axis (0…maxT).
   */
  const timeFromClientX = useCallback(
    (clientX: number): number | null => {
      if (!layout) return null;
      const overlay = overlayRef.current;
      if (!overlay) return null;
      const rect = overlay.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const f = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(layout.maxT, f * layout.maxT));
    },
    [layout],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<SVGRectElement>) => {
      if (e.pointerType === "mouse") return;
      gesture.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        scrubbing: false,
      };
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<SVGRectElement>) => {
      if (!onHover) return;
      const g = gesture.current;
      if (g && g.id === e.pointerId) {
        // Touch / pen contact: vertical drags belong to page scrolling
        // (the browser cancels them); a clearly sideways drag scrubs.
        if (!g.scrubbing) {
          const dx = Math.abs(e.clientX - g.x);
          const dy = Math.abs(e.clientY - g.y);
          if (dx < SCRUB_SLOP_PX || dx <= dy) return;
          g.scrubbing = true;
          capturePointer(e);
        }
        const t = timeFromClientX(e.clientX);
        if (t != null) onHover({ type: "tap", time: t });
        return;
      }
      // Mouse / hovering pen: preview only. The parent ignores previews
      // once a time has been locked.
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      if (e.buttons || e.pressure > 0) return;
      const t = timeFromClientX(e.clientX);
      if (t == null) return;
      onHover({ type: "hover", time: t });
    },
    [onHover, timeFromClientX],
  );

  const endGesture = useCallback((e: ReactPointerEvent<SVGRectElement>) => {
    if (gesture.current?.id === e.pointerId) gesture.current = null;
  }, []);

  const handleClick = useCallback(
    (e: ReactMouseEvent<SVGRectElement>) => {
      // Browsers emit click for a completed mouse click, finger tap or
      // pen tap, but suppress it when a touch gesture scrolls the page.
      const t = timeFromClientX(e.clientX);
      if (t != null) onHover?.({ type: "tap", time: t });
    },
    [onHover, timeFromClientX],
  );

  const handlePointerLeave = useCallback(
    (e: ReactPointerEvent<SVGRectElement>) => {
      if (!onHover) return;
      // Only mouse leaves are reported. The parent keeps that last position
      // visible; touch lifts never change a locked selection.
      if (e.pointerType === "mouse") {
        onHover({ type: "leave" });
      }
    },
    [onHover],
  );

  if (!layout) {
    return <ChartEmptyState />;
  }

  const hover = computeHoverPoints(layout, hoveredTime);
  const readout = hover ?? endOfGame(layout);
  const you = myName?.trim() || "You";
  const them = oppName?.trim() || "Opponent";
  const scaleX = size ? size.width / layout.width : 1;
  const title = layout.metric.title;

  return (
    <figure
      aria-label={showTitle ? undefined : "Match timeline chart"}
      aria-labelledby={showTitle ? `${clipId}-title` : undefined}
      className={`space-y-2 ${className}`}
    >
      {showTitle ? (
        <figcaption
          id={`${clipId}-title`}
          className="text-caption font-semibold uppercase tracking-wider text-text"
        >
          Match timeline
        </figcaption>
      ) : null}

      <MetricSwitch metric={metric} onMetric={setMetric} race={myRace} />

      <div
        ref={containerRef}
        // Vertical drags scroll the page; sideways drags stay with the
        // chart so they can scrub. Set on this HTML box because Chrome
        // ignores ``touch-action`` on SVG shapes like the overlay rect.
        style={{ touchAction: "pan-y pinch-zoom" }}
        className="relative h-[clamp(180px,28vh,260px)] w-full sm:h-[clamp(260px,44vh,460px)]"
      >
        <svg
          role="img"
          aria-label={`${title} for both players over game time. Hover to inspect a moment; click or tap to lock it, or drag sideways to scrub.`}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 block h-full w-full"
        >
          <Grid layout={layout} />
          {showSupplyBlocks ? (
            <SupplyBlockBands
              layout={layout}
              my={supplyBlockWindows}
              opp={oppSupplyBlockWindows}
            />
          ) : null}
          <XAxis layout={layout} />
          <LeakMarkers
            layout={layout}
            leaks={leaks}
            highlightedKey={highlightedKey}
          />
          <LeadShading layout={layout} clipId={clipId} />
          <SeriesLines layout={layout} />
          {hover ? <HoverCrosshair layout={layout} hover={hover} /> : null}
          <YAxisLabels layout={layout} />
          <rect
            ref={overlayRef}
            x={layout.plotLeft}
            y={layout.plotTop}
            width={layout.innerW}
            height={layout.innerH}
            fill="transparent"
            style={{ touchAction: "pan-y pinch-zoom", cursor: onHover ? "crosshair" : "default" }}
            onPointerDown={onHover ? handlePointerDown : undefined}
            onPointerMove={onHover ? handlePointerMove : undefined}
            onPointerUp={onHover ? endGesture : undefined}
            onPointerCancel={onHover ? endGesture : undefined}
            onPointerLeave={onHover ? handlePointerLeave : undefined}
            onClick={onHover ? handleClick : undefined}
            aria-hidden
          />
        </svg>
        {hover ? (
          <ChartTooltip
            layout={layout}
            hover={hover}
            scaleX={scaleX}
            myName={you}
            oppName={them}
            myBlocked={showSupplyBlocks && blockedAt(supplyBlockWindows, hover.cursorT)}
            oppBlocked={showSupplyBlocks && blockedAt(oppSupplyBlockWindows, hover.cursorT)}
          />
        ) : null}
      </div>

      <TimelineSummary
        metric={layout.metric}
        time={readout.t}
        locked={locked && hover != null}
        my={readout.my}
        opp={readout.opp}
        myName={you}
        oppName={them}
      />

      <AccessibleLeakTable leaks={leaks} highlightedKey={highlightedKey} />
    </figure>
  );
}

/**
 * Track an element's content-box size in whole CSS pixels through a
 * callback ref, so it attaches whenever the chart box mounts (it is
 * absent while the empty state shows). Rounding keeps sub-pixel layout
 * jitter from re-rendering the chart.
 */
function useElementSize(): [
  (node: HTMLDivElement | null) => void,
  { width: number; height: number } | null,
] {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width <= 0 || box.height <= 0) return;
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      setSize((prev) =>
        prev && prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, size];
}

/** Keep receiving a scrub's moves after the finger leaves the plot. */
function capturePointer(e: ReactPointerEvent<SVGRectElement>) {
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch {
    // Capture is an optimisation; scrubbing works without it.
  }
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
    cursorT: clamped,
    xView: layout.xOf(t),
    xMouseView: layout.xOf(clamped),
    my,
    opp,
  };
}

/** What the read-out shows before anything is inspected: the final samples. */
function endOfGame(layout: ChartLayout): {
  t: number;
  my: SeriesPoint | null;
  opp: SeriesPoint | null;
} {
  return {
    t: layout.maxT,
    my: layout.mySeries[layout.mySeries.length - 1] ?? null,
    opp: layout.oppSeries[layout.oppSeries.length - 1] ?? null,
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
        The match timeline needs the per-second sample stream from your
        SC2 agent. Re-run the agent or click Recompute to ask it to
        re-parse the replay file.
      </p>
    </div>
  );
}
