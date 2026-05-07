"use client";

import { useState } from "react";
import { ActiveArmyChart } from "./ActiveArmyChart";
import { UnitCompositionSnapshot } from "./UnitCompositionSnapshot";
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
}

/**
 * Pulls the chart and the composition snapshot into a single section
 * sharing one hover state so the user gets the sc2replaystats
 * "scrub the timeline → see the army at that moment" interaction.
 *
 * Why a wrapper component instead of lifting state into the panel:
 * the panel already manages a leak-highlight key shared with the
 * leaks list and the chart marker layer. Adding the hover-time
 * state next to it would couple two unrelated concerns; a small
 * dedicated section keeps each piece of state local to where it's
 * actually rendered.
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
      <UnitCompositionSnapshot
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
