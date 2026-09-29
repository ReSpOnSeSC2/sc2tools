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
  type RefObject,
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
import { TimelineTooltip } from "./TimelineTooltip";
import type { HoverEvent } from "./timelineSelection";
import type { GamePace } from "@/lib/apm";
import {
  DEFAULT_TIMELINE_METRIC,
  selectedMetrics,
  timelineMetricsFor,
  type TimelineMetric,
  type TimelineMetricDef,
} from "./timelineMetrics";

export type { ActiveArmySupplyBlockWindow } from "./ActiveArmyChartParts";
export type { HoverEvent } from "./timelineSelection";

/**
 * Mark a host control that sits outside the chart but belongs to it
 * (e.g. the supply-block switch) with this attribute, so tapping it
 * does not close the read-out card.
 */
export const TIMELINE_CONTROL_ATTR = "data-timeline-control";

/** The metrics every game has; APM joins them when its curve is trusted. */
const BASE_METRICS = timelineMetricsFor({ apm: false });

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
  /**
   * Show the dark read-out card at ``hoveredTime`` (default true). Hosts
   * turn it off on the "dismiss" event — a tap off the chart — while the
   * crosshair and read-out keep the moment.
   */
  tooltipOpen?: boolean;
  /** Callback fired for every hover/tap/leave/dismiss event. */
  onHover?: (event: HoverEvent) => void;
  /** Display name of the local player (for the tooltip header). */
  myName?: string | null;
  /** Display name of the opponent (for the tooltip header). */
  oppName?: string | null;
  /** Your race, for the metric switch's icons. */
  myRace?: string | null;
  /** Metrics this game offers; APM is included only with a trusted curve. */
  metrics?: readonly TimelineMetricDef[];
  /** Each player's game-average APM and SPM, shown under the APM view. */
  apmAverages?: { my: GamePace | null; opp: GamePace | null } | null;
  /** Draw the supply-block bands (the host owns the on/off switch). */
  showSupplyBlocks?: boolean;
  /** Render the "Match timeline" caption (off when the host titles it). */
  showTitle?: boolean;
  /** Classes for the outer figure (e.g. sticky positioning). */
  className?: string;
}

/** Sideways travel, in pixels, before a touch drag scrubs the chart. */
const SCRUB_SLOP_PX = 8;
/** Travel, in pixels, that turns a press off the chart into a drag. */
const TAP_SLOP_PX = 10;

interface TouchGesture {
  id: number;
  x: number;
  y: number;
  scrubbing: boolean;
}

/**
 * Match timeline — interactive SVG chart.
 *
 * Any mix of metrics (army value, workers, supply, income, APM), both
 * players overlaid in their colours. One metric gets its real scale and
 * the gap between the lines shaded for whoever leads; several share the
 * plot indexed to their game peaks, told apart by line pattern. Also:
 * labelled supply-block bands, a dashed crosshair, a dark read-out card
 * and a "Game time | you | opponent" read-out underneath. The hovered
 * time is lifted to the parent so the unit roster below stays in sync.
 *
 * The SVG is laid out at its measured pixel size, so it fills the
 * width of any screen without stretching text. Height comes from CSS.
 *
 * Mouse: moving previews a time; click locks it. Touch: tap locks a
 * time and a sideways drag scrubs it, while vertical drags scroll the
 * page (``touch-action: pan-y``) and never move the lock. A click or
 * tap anywhere off the chart asks the host to close the card
 * ("dismiss"); scrolling never does.
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
  tooltipOpen = true,
  onHover,
  myName,
  oppName,
  myRace,
  metrics = BASE_METRICS,
  apmAverages = null,
  showSupplyBlocks = true,
  showTitle = true,
  className = "",
}: ActiveArmyChartProps) {
  const chartId = useId();
  const clipId = `timeline-${chartId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const figureRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<SVGRectElement | null>(null);
  const gesture = useRef<TouchGesture | null>(null);
  const [containerRef, size] = useElementSize();
  const [chosen, setChosen] = useState<TimelineMetric[]>([DEFAULT_TIMELINE_METRIC]);
  const shown = useMemo(
    () => selectedMetrics(chosen, metrics).map((m) => m.key),
    [chosen, metrics],
  );

  const layout = useMemo(
    () =>
      buildLayout(mySeries, oppSeries, gameLengthSec, {
        metrics: shown,
        width: size?.width,
        height: size?.height,
      }),
    [mySeries, oppSeries, gameLengthSec, shown, size],
  );

  const dismiss = useCallback(() => onHover?.({ type: "dismiss" }), [onHover]);
  useDismissOnTapOutside(
    figureRef,
    Boolean(onHover) && hoveredTime != null && (tooltipOpen || locked),
    dismiss,
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
  const plotted = layout.tracks.map((tr) => tr.metric);

  return (
    <figure
      ref={figureRef}
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

      <MetricSwitch selected={shown} onChange={setChosen} race={myRace} metrics={metrics} />

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
          aria-label={chartLabel(plotted)}
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
        {plotted.length === 0 ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center"
            style={{ bottom: `${layout.height - layout.plotBottom}px`, paddingLeft: `${layout.plotLeft * scaleX}px` }}
          >
            <p className="rounded-full border border-border bg-bg-surface/90 px-3 py-1 text-micro font-semibold text-text-muted shadow-sm">
              Pick a metric above to plot it
            </p>
          </div>
        ) : null}
        {hover && tooltipOpen && plotted.length > 0 ? (
          <TimelineTooltip
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
        metrics={plotted}
        time={readout.t}
        locked={locked && hover != null}
        my={readout.my}
        opp={readout.opp}
        myName={you}
        oppName={them}
        averages={apmAverages}
      />

      <AccessibleLeakTable leaks={leaks} highlightedKey={highlightedKey} />
    </figure>
  );
}

/** The chart's accessible name for the plotted metrics. */
function chartLabel(plotted: readonly TimelineMetricDef[]): string {
  const how =
    "Hover to inspect a moment; click or tap to lock it, or drag sideways to scrub.";
  if (plotted.length === 0) {
    return "Match timeline with no metric selected. Pick one above to plot it.";
  }
  const titles = plotted.map((m) => m.title);
  const named =
    titles.length === 1
      ? titles[0]
      : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
  const scale = plotted.length > 1 ? ", each as a share of its game peak" : "";
  return `${named} for both players over game time${scale}. ${how}`;
}

/**
 * While the read-out card is up (or a moment is locked), a click or tap
 * that starts and ends off the chart calls ``onDismiss``. Presses on the
 * chart itself or on a host control marked ``TIMELINE_CONTROL_ATTR``
 * never do, and neither does scrolling: a touch pan cancels the pointer,
 * any scroll during the press voids it, and a press that travels is a
 * drag, not a tap.
 */
function useDismissOnTapOutside(
  figureRef: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!active) return;
    let press: { id: number; x: number; y: number } | null = null;
    const onChart = (target: EventTarget | null) =>
      target instanceof Element &&
      (figureRef.current?.contains(target) === true ||
        target.closest(`[${TIMELINE_CONTROL_ATTR}]`) != null);
    const down = (e: PointerEvent) => {
      press =
        e.isPrimary === false || e.button > 0 || onChart(e.target)
          ? null
          : { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    const up = (e: PointerEvent) => {
      const start = press;
      press = null;
      if (!start || start.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP_PX) return;
      onDismiss();
    };
    const drop = () => {
      press = null;
    };
    const listen = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", down, listen);
    document.addEventListener("pointerup", up, listen);
    document.addEventListener("pointercancel", drop, listen);
    document.addEventListener("scroll", drop, listen);
    return () => {
      document.removeEventListener("pointerdown", down, listen);
      document.removeEventListener("pointerup", up, listen);
      document.removeEventListener("pointercancel", drop, listen);
      document.removeEventListener("scroll", drop, listen);
    };
  }, [active, onDismiss, figureRef]);
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
