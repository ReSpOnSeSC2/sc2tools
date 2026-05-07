"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useApi } from "@/lib/clientApi";
import { ActiveArmyChart, type HoverEvent } from "./ActiveArmyChart";
import {
  CompositionSnapshot,
  type BuildOrderResponse,
} from "./CompositionSnapshot";
import type {
  LeakItem,
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";

export interface MacroChartSectionProps {
  samples: StatsEvent[];
  oppSamples: StatsEvent[];
  unitTimeline?: UnitTimelineEntry[];
  gameLengthSec?: number;
  leaks: LeakItem[];
  highlightedKey?: string | null;
  myName?: string | null;
  oppName?: string | null;
  myRace?: string | null;
  oppRace?: string | null;
  /**
   * Game id, threaded through so the build-order endpoint can be
   * fetched once and shared between the chart (used to compute army
   * value with the same source as the roster) and the composition
   * snapshot below.
   */
  gameId?: string | null;
}

/** Hover state with sticky semantics. ``sticky=true`` means the value
 *  was set by a touch tap and persists until the user taps outside the
 *  chart. ``sticky=false`` is a transient mouse-hover that clears on
 *  pointer-leave. */
interface HoverState {
  time: number | null;
  sticky: boolean;
}

const INITIAL_HOVER: HoverState = { time: null, sticky: false };

/**
 * Active Army & Workers chart + the live unit/building composition
 * panel beneath it. The two share a hovered-time state so scrubbing
 * the chart instantly updates the composition counts (sc2replaystats
 * parity).
 *
 * The build-order endpoint is fetched ONCE here and passed down to
 * both children. The chart uses it to derive its army series the
 * exact same way the roster does (``deriveUnitComposition``), so the
 * "Army 725" header next to the player and the chart line agree at
 * every tick — previously the chart used a strict unit_timeline
 * exact-time lookup with a food*8 fallback, which silently diverged
 * from the roster whenever sample/timeline times didn't align.
 *
 * Hover behaviour:
 *   - Mouse: continuous hover that clears on pointer-leave.
 *   - Touch / pen: tap (or drag-tap) locks the crosshair. The user
 *     does NOT have to keep their finger pressed — release leaves the
 *     value visible. Tapping outside the chart container (still inside
 *     the modal) or anywhere else in the document clears the lock.
 */
export function MacroChartSection({
  samples,
  oppSamples,
  unitTimeline,
  gameLengthSec,
  leaks,
  highlightedKey,
  myName,
  oppName,
  myRace,
  oppRace,
  gameId,
}: MacroChartSectionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState>(INITIAL_HOVER);

  const buildOrder = useApi<BuildOrderResponse>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/build-order` : null,
    { revalidateOnFocus: false },
  );

  const handleHover = useCallback((event: HoverEvent) => {
    setHover((prev) => {
      if (event.type === "tap") {
        // Touch / pen tap → lock at this time. Subsequent taps update
        // the lock; releasing the finger does NOT clear it.
        return { time: event.time, sticky: true };
      }
      if (event.type === "hover") {
        // Mouse move — only updates while we're not locked. (We never
        // expect both mouse and touch on the same element in practice,
        // but if a hybrid device fires both, the locked state wins.)
        if (prev.sticky) return prev;
        return { time: event.time, sticky: false };
      }
      // event.type === "leave"
      if (prev.sticky) return prev;
      return INITIAL_HOVER;
    });
  }, []);

  // Click-outside listener that clears a sticky lock. Only attaches
  // while the lock is active so we don't pay for a global handler all
  // the time. Uses pointerdown so it fires before the parent dialog's
  // onClick handlers and works for both mouse and touch.
  useEffect(() => {
    if (!hover.sticky) return;
    const handleOutside = (ev: PointerEvent) => {
      const node = containerRef.current;
      if (!node) return;
      if (ev.target instanceof Node && node.contains(ev.target)) return;
      setHover(INITIAL_HOVER);
    };
    document.addEventListener("pointerdown", handleOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
    };
  }, [hover.sticky]);

  return (
    <div ref={containerRef} className="space-y-3">
      <ActiveArmyChart
        samples={samples}
        oppSamples={oppSamples}
        unitTimeline={unitTimeline}
        myBuildEvents={buildOrder.data?.events}
        oppBuildEvents={buildOrder.data?.opp_events}
        gameLengthSec={gameLengthSec}
        leaks={leaks}
        highlightedKey={highlightedKey}
        hoveredTime={hover.time}
        onHover={handleHover}
        myName={myName}
        oppName={oppName}
      />
      {hover.sticky ? (
        <p className="text-[11px] text-text-muted">
          <span className="text-text">Locked</span> at this point. Tap
          another spot to move it, or tap outside the chart to clear.
        </p>
      ) : null}
      <CompositionSnapshot
        unitTimeline={unitTimeline}
        mySamples={samples}
        oppSamples={oppSamples}
        hoveredTime={hover.time}
        gameLengthSec={gameLengthSec}
        myName={myName}
        oppName={oppName}
        myRace={myRace}
        oppRace={oppRace}
        buildOrderData={buildOrder.data}
        buildOrderLoading={buildOrder.isLoading}
        buildOrderError={Boolean(buildOrder.error)}
      />
    </div>
  );
}
