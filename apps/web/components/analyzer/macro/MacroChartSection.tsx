"use client";

import { useState } from "react";
import { ActiveArmyChart } from "./ActiveArmyChart";
import { CompositionSnapshot } from "./CompositionSnapshot";
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
   * Game id, threaded through so the composition snapshot can fetch
   * the per-game build order and derive a buildings-over-time view.
   */
  gameId?: string | null;
}

/**
 * Active Army & Workers chart + the live unit/building composition
 * panel beneath it. The two share a hovered-time state so scrubbing
 * the chart instantly updates the composition counts (sc2replaystats
 * parity).
 *
 * The composition snapshot owns its own data fetches (build order via
 * SWR keyed on ``gameId``) so the chart never blocks on them.
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
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  return (
    <div className="space-y-3">
      <ActiveArmyChart
        samples={samples}
        oppSamples={oppSamples}
        unitTimeline={unitTimeline}
        gameLengthSec={gameLengthSec}
        leaks={leaks}
        highlightedKey={highlightedKey}
        hoveredTime={hoveredTime}
        onHoverTime={setHoveredTime}
        myName={myName}
        oppName={oppName}
      />
      <CompositionSnapshot
        gameId={gameId ?? null}
        unitTimeline={unitTimeline}
        mySamples={samples}
        oppSamples={oppSamples}
        hoveredTime={hoveredTime}
        gameLengthSec={gameLengthSec}
        myName={myName}
        oppName={oppName}
        myRace={myRace}
        oppRace={oppRace}
      />
    </div>
  );
}
