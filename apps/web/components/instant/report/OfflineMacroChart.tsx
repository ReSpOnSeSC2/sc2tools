"use client";

/**
 * The analyzer's macro timeline for a /try game — the same
 * `ActiveArmyChart` (army / workers / supply / income / APM with supply
 * blocks and leak markers) and `CompositionSnapshot` (unit, building
 * and upgrade roster at the inspected moment), fed from the local
 * payload.
 *
 * Why not `MacroChartSection` itself: it can only get the build order
 * (which the roster needs for buildings and upgrades) from
 * GET /v1/games/:id/build-order. With no game id it fetches nothing and
 * its roster then says "Buildings unavailable" and "No upgrades yet" —
 * the second is false for any game with an upgrade. This thin host keeps
 * its selection behaviour (hover previews, click/tap locks, tap-off
 * dismissal, supply-block switch) and hands the roster the build order parsed on this device,
 * so every row is real and the page still makes no API request.
 *
 * Example:
 *   const props = macroChartProps(payload, gameBuilds(payload));
 *   {props ? <OfflineMacroChart {...props} /> : null}
 */
import { useCallback, useMemo, useState } from "react";
import { ActiveArmyChart, TIMELINE_CONTROL_ATTR } from "@/components/analyzer/macro/ActiveArmyChart";
import { CompositionSnapshot } from "@/components/analyzer/macro/CompositionSnapshot";
import { buildSeries } from "@/components/analyzer/macro/activeArmyLayout";
import { timelineMetricsFor } from "@/components/analyzer/macro/timelineMetrics";
import { INITIAL_HOVER, nextHover, type HoverEvent, type HoverState } from "@/components/analyzer/macro/timelineSelection";
import { Toggle } from "@/components/ui/Toggle";
import { gamePace, withApm } from "@/lib/apm";
import type { OfflineMacroChartProps } from "@/lib/instant/reportGameDetail";

/**
 * `MacroChartSection`'s selection rule (see `timelineSelection`): a
 * click/tap locks a time, hover previews until something is locked,
 * leaving keeps the last time, a tap off the chart closes the card.
 */
export { nextHover };
export type { HoverState };

/** Both players' per-tick series with APM, built once for chart and roster. */
function useSeries(props: OfflineMacroChartProps) {
  const { samples, oppSamples, unitTimeline, buildOrder, apm = null, patchEra } = props;
  const mySeries = useMemo(
    () => withApm(buildSeries(samples, unitTimeline, "my", buildOrder.events, patchEra), apm?.me, apm?.windowSec ?? 0),
    [samples, unitTimeline, buildOrder.events, apm, patchEra],
  );
  const oppSeries = useMemo(
    () => withApm(buildSeries(oppSamples, unitTimeline, "opp", buildOrder.opp_events, patchEra), apm?.opp, apm?.windowSec ?? 0),
    [oppSamples, unitTimeline, buildOrder.opp_events, apm, patchEra],
  );
  const metrics = useMemo(() => timelineMetricsFor({ apm: apm !== null }), [apm]);
  const apmAverages = useMemo(() => (apm ? { my: gamePace(apm.me), opp: gamePace(apm.opp) } : null), [apm]);
  return { mySeries, oppSeries, metrics, apmAverages };
}

function TimelineHeader({ hasBlocks, showBlocks, onShowBlocks }: { hasBlocks: boolean; showBlocks: boolean; onShowBlocks: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 sm:px-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">Match timeline</h3>
        <p className="text-micro text-text-muted">Hover, tap or drag across the chart to inspect a moment</p>
      </div>
      {hasBlocks ? (
        <label {...{ [TIMELINE_CONTROL_ATTR]: "" }} className="flex flex-shrink-0 items-center gap-2 text-micro font-semibold text-text-muted">
          <span className="whitespace-nowrap">Supply blocks</span>
          <Toggle checked={showBlocks} onChange={onShowBlocks} label="Show supply blocks" />
        </label>
      ) : null}
    </div>
  );
}

/**
 * Chart + roster sharing one inspected time (see module comment).
 *
 * Example:
 *   <OfflineMacroChart samples={samples} oppSamples={[]} leaks={[]} buildOrder={{ events: [], opp_events: [] }} />
 */
export function OfflineMacroChart(props: OfflineMacroChartProps) {
  const [hover, setHover] = useState<HoverState>(INITIAL_HOVER);
  const [showBlocks, setShowBlocks] = useState(true);
  const { mySeries, oppSeries, metrics, apmAverages } = useSeries(props);
  const handleHover = useCallback((event: HoverEvent) => setHover((prev) => nextHover(prev, event)), []);
  const { supplyBlockWindows, oppSupplyBlockWindows, myName, oppName, myRace, oppRace, gameLengthSec } = props;
  const hasBlocks = (supplyBlockWindows?.length ?? 0) + (oppSupplyBlockWindows?.length ?? 0) > 0;
  return (
    <div className="space-y-3">
      <TimelineHeader hasBlocks={hasBlocks} showBlocks={showBlocks} onShowBlocks={setShowBlocks} />
      <ActiveArmyChart
        mySeries={mySeries}
        oppSeries={oppSeries}
        gameLengthSec={gameLengthSec}
        leaks={props.leaks}
        supplyBlockWindows={supplyBlockWindows}
        oppSupplyBlockWindows={oppSupplyBlockWindows}
        hoveredTime={hover.time}
        locked={hover.sticky}
        tooltipOpen={hover.card}
        onHover={handleHover}
        myName={myName}
        oppName={oppName}
        myRace={myRace}
        metrics={metrics}
        apmAverages={apmAverages}
        showSupplyBlocks={showBlocks}
        showTitle={false}
        className="px-3 pt-2 sm:px-0 sm:pt-0"
      />
      <div className="px-4 sm:px-0">
        <CompositionSnapshot
          mySeries={mySeries}
          oppSeries={oppSeries}
          unitTimeline={props.unitTimeline}
          hoveredTime={hover.time}
          gameLengthSec={gameLengthSec}
          myName={myName}
          oppName={oppName}
          myRace={myRace}
          oppRace={oppRace}
          buildOrderData={props.buildOrder}
          myProductionBuildings={props.myProductionBuildings}
          oppProductionBuildings={props.oppProductionBuildings}
          patchEra={props.patchEra}
        />
      </div>
    </div>
  );
}
