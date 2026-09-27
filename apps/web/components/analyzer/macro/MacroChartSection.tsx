"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useApi } from "@/lib/clientApi";
import {
  ActiveArmyChart,
  type ActiveArmySupplyBlockWindow,
  type HoverEvent,
} from "./ActiveArmyChart";
import {
  CompositionSnapshot,
  type BuildOrderResponse,
} from "./CompositionSnapshot";
import type {
  LeakItem,
  ProductionBuildingRecord,
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";
import { buildSeries } from "./activeArmyLayout";

export interface MacroChartSectionProps {
  samples: StatsEvent[];
  oppSamples: StatsEvent[];
  unitTimeline?: UnitTimelineEntry[];
  /** Per-structure lifetimes (born/died plus lifecycle result) used by
   *  both rosters to drop destroyed buildings. */
  myProductionBuildings?: ProductionBuildingRecord[];
  oppProductionBuildings?: ProductionBuildingRecord[];
  gameLengthSec?: number;
  leaks: LeakItem[];
  /** Per-window supply-block annotations for the local player. */
  supplyBlockWindows?: ActiveArmySupplyBlockWindow[];
  /** Per-window supply-block annotations for the opponent. */
  oppSupplyBlockWindows?: ActiveArmySupplyBlockWindow[];
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
 *  was selected by a click or tap and persists until another selection.
 *  ``sticky=false`` is the latest mouse position: it remains
 *  visible after pointer-leave, then resumes following the cursor as
 *  soon as the mouse re-enters the plot. */
interface HoverState {
  time: number | null;
  sticky: boolean;
}

const INITIAL_HOVER: HoverState = { time: null, sticky: false };

/**
 * Match timeline chart + the live unit/building composition panel
 * beneath it. The two share a hovered-time state so scrubbing the
 * chart instantly updates the composition counts (sc2replaystats
 * parity). On phones the chart pins under the panel header while the
 * roster scrolls beneath it.
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
 *   - Mouse: continuous hover; pointer-leave keeps the last inspected
 *     time, tooltip, composition, and vertical crosshair visible.
 *   - Click / tap: locks the crosshair until another chart click or tap.
 *     Scrolling, outside interactions, and hovering preserve the lock.
 *     A sideways touch drag scrubs the lock along the chart.
 *     Opening a different game resets the selection.
 */
export function MacroChartSection({
  samples,
  oppSamples,
  unitTimeline,
  myProductionBuildings,
  oppProductionBuildings,
  gameLengthSec,
  leaks,
  supplyBlockWindows,
  oppSupplyBlockWindows,
  highlightedKey,
  myName,
  oppName,
  myRace,
  oppRace,
  gameId,
}: MacroChartSectionProps) {
  const [hover, setHover] = useState<HoverState>(INITIAL_HOVER);

  useEffect(() => {
    setHover(INITIAL_HOVER);
  }, [gameId]);

  const buildOrder = useApi<BuildOrderResponse>(
    gameId ? `/v1/games/${encodeURIComponent(gameId)}/build-order` : null,
    { revalidateOnFocus: false },
  );

  // Build the per-tick series ONCE here and thread to both children.
  // ActiveArmyChart turns it into the line geometry; CompositionSnapshot
  // reads the same SeriesPoint (army value, worker count, alive units)
  // at hover time via ``nearestPriorPoint`` — so the tooltip number,
  // the roster header's "Army NNN", the worker count under the worker
  // chip, AND the unit chips next to it ALL come from the same
  // SeriesPoint at the same ``t``. Single source of truth: the chart
  // and the roster mathematically cannot disagree at a hovered tick.
  const mySeries = useMemo(
    () =>
      buildSeries(
        samples,
        unitTimeline,
        "my",
        buildOrder.data?.events,
      ),
    [samples, unitTimeline, buildOrder.data?.events],
  );
  const oppSeries = useMemo(
    () =>
      buildSeries(
        oppSamples,
        unitTimeline,
        "opp",
        buildOrder.data?.opp_events,
      ),
    [oppSamples, unitTimeline, buildOrder.data?.opp_events],
  );

  const handleHover = useCallback((event: HoverEvent) => {
    setHover((prev) => {
      if (event.type === "tap") {
        // A deliberate click or tap replaces the lock. Scrolling and
        // moving the pointer must not change the selected time.
        return { time: event.time, sticky: true };
      }
      if (event.type === "hover") {
        // Hover previews are available until a click or tap locks a time.
        if (prev.sticky) return prev;
        return { time: event.time, sticky: false };
      }
      // event.type === "leave". Preserve the last mouse position so the
      // tooltip, composition snapshot, and vertical crosshair stay locked
      // together after the pointer exits. Because sticky remains false, the
      // very next mouse move inside the chart updates the selection normally.
      return prev;
    });
  }, []);

  return (
    // This wrapper is the sticky chart's containing block: on phones the
    // chart stays pinned under the panel header while the roster scrolls
    // beneath it, then leaves with the roster (sc2replaystats layout).
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 sm:px-0">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          Match timeline
        </h3>
        <p className="text-micro text-text-muted">
          Hover, tap or drag across the chart to inspect a moment
        </p>
      </div>
      <ActiveArmyChart
        mySeries={mySeries}
        oppSeries={oppSeries}
        gameLengthSec={gameLengthSec}
        leaks={leaks}
        supplyBlockWindows={supplyBlockWindows}
        oppSupplyBlockWindows={oppSupplyBlockWindows}
        highlightedKey={highlightedKey}
        hoveredTime={hover.time}
        locked={hover.sticky}
        onHover={handleHover}
        myName={myName}
        oppName={oppName}
        showTitle={false}
        className="sticky top-[var(--macro-header-h,0px)] z-[5] bg-bg-surface px-3 pt-2 shadow-[0_8px_12px_-12px_rgb(0_0_0/0.5)] sm:static sm:z-auto sm:bg-transparent sm:px-0 sm:pt-0 sm:shadow-none"
      />
      <div className="px-4 sm:px-0">
        <CompositionSnapshot
          mySeries={mySeries}
          oppSeries={oppSeries}
          unitTimeline={unitTimeline}
          hoveredTime={hover.time}
          gameLengthSec={gameLengthSec}
          myName={myName}
          oppName={oppName}
          myRace={myRace}
          oppRace={oppRace}
          buildOrderData={buildOrder.data}
          buildOrderLoading={buildOrder.isLoading}
          buildOrderError={Boolean(buildOrder.error)}
          myProductionBuildings={myProductionBuildings}
          oppProductionBuildings={oppProductionBuildings}
        />
      </div>
    </div>
  );
}
