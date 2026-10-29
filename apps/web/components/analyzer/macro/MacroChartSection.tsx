"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { Toggle } from "@/components/ui/Toggle";
import { useApi } from "@/lib/clientApi";
import {
  ActiveArmyChart,
  TIMELINE_CONTROL_ATTR,
  type ActiveArmySupplyBlockWindow,
} from "./ActiveArmyChart";
import {
  CompositionSnapshot,
  type BuildOrderResponse,
} from "./CompositionSnapshot";
import { CasualtySnapshot } from "./CasualtySnapshot";
import type {
  CasualtyEvent,
  LeakItem,
  ProductionBuildingRecord,
  StatsEvent,
  UnitTimelineEntry,
} from "./MacroBreakdownPanel.types";
import { buildSeries } from "./activeArmyLayout";
import {
  selectedMetrics,
  timelineMetricsFor,
} from "./timelineMetrics";
import { useTimelineBankView, useTimelineMetrics } from "./useTimelineMetrics";
import { BankViewSwitch, MetricSwitch } from "./TimelineControls";
import { MacroOverviewFit } from "./MacroOverviewFit";
import {
  INITIAL_HOVER,
  nextHover,
  type HoverEvent,
  type HoverState,
} from "./timelineSelection";
import { gamePace, withApm, type GameApm } from "@/lib/apm";
import type { PatchEra } from "@/lib/meta";

export interface MacroChartSectionProps {
  /** Fit only the modal's chart and both rosters, with unscaled controls. */
  fitOverview?: boolean;
  inspectionTime?: number | null;
  onSeek?: (time: number) => void;
  samples: StatsEvent[];
  oppSamples: StatsEvent[];
  unitTimeline?: UnitTimelineEntry[];
  /** Exact deaths through the selected moment; absence means legacy data. */
  casualtyEvents?: CasualtyEvent[];
  onRecompute?: () => void;
  recomputing?: boolean;
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
  /**
   * The game's trusted APM curve (lib/apm.ts readGameApm). When present,
   * the timeline switch gains an APM metric; null leaves it out.
   */
  apm?: GameApm | null;
  /**
   * The game's patch era (lib/ladderPulse ``patchEraForGame``). It prices
   * the derived army value and the roster's unit costs; omitted, the
   * live 12-worker game.
   */
  patchEra?: PatchEra | null;
}

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
 * Hover behaviour (``timelineSelection``):
 *   - Mouse: continuous hover; pointer-leave keeps the last inspected
 *     time, tooltip, composition, and vertical crosshair visible.
 *   - Click / tap: locks the crosshair until another chart click or tap.
 *     Scrolling and hovering preserve the lock. A sideways touch drag
 *     scrubs the lock along the chart.
 *   - Click / tap off the chart: closes the tooltip and releases the
 *     lock; the inspected time (crosshair, read-out, roster) stays.
 *     Scrolling never closes it.
 *     Opening a different game resets the selection.
 */
export function MacroChartSection({
  inspectionTime,
  onSeek,
  samples,
  oppSamples,
  unitTimeline,
  casualtyEvents,
  onRecompute,
  recomputing,
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
  apm = null,
  patchEra,
  fitOverview = false,
}: MacroChartSectionProps) {
  const [hover, setHover] = useState<HoverState>(INITIAL_HOVER);
  const [showBlocks, setShowBlocks] = useState(true);
  const supplyToggleId = useId();
  const [chosenMetrics, setChosenMetrics] = useTimelineMetrics();
  const [bankView, setBankView] = useTimelineBankView();
  const hasBlocks =
    (supplyBlockWindows?.length ?? 0) + (oppSupplyBlockWindows?.length ?? 0) > 0;

  useEffect(() => {
    setHover(INITIAL_HOVER);
  }, [gameId]);
  useEffect(() => {
    if (inspectionTime != null && Number.isFinite(inspectionTime)) setHover({ time: inspectionTime, sticky: true, card: false });
  }, [inspectionTime]);

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
  // APM rides on the same SeriesPoints, so the APM metric shares the
  // chart's crosshair, lead shading and read-out with every other metric.
  const mySeries = useMemo(
    () =>
      withApm(
        buildSeries(samples, unitTimeline, "my", buildOrder.data?.events, patchEra),
        apm?.me,
        apm?.windowSec ?? 0,
      ),
    [samples, unitTimeline, buildOrder.data?.events, apm, patchEra],
  );
  const oppSeries = useMemo(
    () =>
      withApm(
        buildSeries(oppSamples, unitTimeline, "opp", buildOrder.data?.opp_events, patchEra),
        apm?.opp,
        apm?.windowSec ?? 0,
      ),
    [oppSamples, unitTimeline, buildOrder.data?.opp_events, apm, patchEra],
  );
  const metrics = useMemo(() => timelineMetricsFor({ apm: apm !== null }), [apm]);
  const shownMetrics = selectedMetrics(chosenMetrics, metrics);
  const hasArmy = shownMetrics.some((metric) => metric.key === "army");
  const hasWorkers = shownMetrics.some((metric) => metric.key === "workers");
  const finalTime = Math.max(
    gameLengthSec ?? 0,
    mySeries[mySeries.length - 1]?.t ?? 0,
    oppSeries[oppSeries.length - 1]?.t ?? 0,
  );
  const casualtyTime = hover.time == null ? finalTime : Math.max(0, Math.min(finalTime, hover.time));
  const apmAverages = useMemo(
    () => (apm ? { my: gamePace(apm.me), opp: gamePace(apm.opp) } : null),
    [apm],
  );

  const handleHover = useCallback(
    (event: HoverEvent) => { setHover((prev) => nextHover(prev, event)); if (event.type === "tap") onSeek?.(event.time); },
    [onSeek],
  );

  const overview = <>
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
        tooltipOpen={hover.card}
        onHover={handleHover}
        myName={myName}
        oppName={oppName}
        myRace={myRace}
        metrics={metrics}
        selected={chosenMetrics}
        onSelectionChange={setChosenMetrics}
        bankView={bankView}
        onBankViewChange={setBankView}
        apmAverages={apmAverages}
        showSupplyBlocks={showBlocks}
        showTitle={false}
        showControls={!fitOverview}
        className={fitOverview ? "static" : "sticky top-[var(--macro-header-h,0px)] z-[5] bg-bg-surface px-3 pt-2 shadow-[0_8px_12px_-12px_rgb(0_0_0/0.5)] sm:static sm:z-auto sm:bg-transparent sm:px-0 sm:pt-0 sm:shadow-none"}
      />
      <div className={fitOverview ? undefined : "px-4 sm:px-0"}>
        <CompositionSnapshot
          fitOverview={fitOverview}
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
          patchEra={patchEra}
        />
      </div>
    </>;

  return (
    // This wrapper is the sticky chart's containing block: on phones the
    // chart stays pinned under the panel header while the roster scrolls
    // beneath it, then leaves with the roster (sc2replaystats layout).
    <div className="space-y-3">
      <div className={`flex items-center justify-between gap-3 px-4 sm:px-0 ${fitOverview ? "flex-wrap" : ""}`}>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
            Match timeline
          </h3>
          <p className="text-micro text-text-muted">
            Hover, tap or drag across the chart to inspect a moment
          </p>
        </div>
        {hasBlocks ? (
          <label
            htmlFor={supplyToggleId}
            {...{ [TIMELINE_CONTROL_ATTR]: "" }}
            className="flex flex-shrink-0 items-center gap-2 text-micro font-semibold text-text-muted"
          >
            <span className="whitespace-nowrap">Supply blocks</span>
            <Toggle
              id={supplyToggleId}
              checked={showBlocks}
              onChange={setShowBlocks}
              label="Show supply blocks"
            />
          </label>
        ) : null}
      </div>
      {fitOverview ? <>
        <div data-timeline-control="" className="space-y-2 px-3 sm:px-0">
          <MetricSwitch selected={shownMetrics.map((metric) => metric.key)} onChange={setChosenMetrics} race={myRace} metrics={metrics} singleRow />
          {shownMetrics.some((metric) => metric.key === "bank") ? <BankViewSwitch view={bankView} onChange={setBankView} /> : null}
        </div>
        <MacroOverviewFit gameId={gameId}>{overview}</MacroOverviewFit>
      </> : overview}
      <div hidden={!hasArmy && !hasWorkers} className="px-4 sm:px-0">
        <CasualtySnapshot
          events={casualtyEvents}
          time={casualtyTime}
          workersOnly={!hasArmy && hasWorkers}
          myName={myName}
          oppName={oppName}
          onRecompute={onRecompute}
          recomputing={recomputing}
          patchEra={patchEra}
        />
      </div>
    </div>
  );
}
