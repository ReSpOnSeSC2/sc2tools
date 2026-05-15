"use client";

import { BandChart } from "./BandChart";
import type {
  CohortTick,
  GameTick,
} from "./shared/snapshotTypes";

// Thin band-chart wrapper for the production_capacity metric.
// Slots into the 2×2 chart grid on desktop (under workers) and
// onto the swipeable mobile card stack as its own card. Shares the
// synced cursor with everything else on the page — when the user
// scrubs, this strip highlights the same tick.

export interface ProductionBandStripProps {
  cohort: CohortTick[];
  gameTicks?: GameTick[];
  cursorTick?: number | null;
  onHover?: (t: number | null) => void;
  compact?: boolean;
}

export function ProductionBandStrip({
  cohort,
  gameTicks,
  cursorTick,
  onHover,
  compact = true,
}: ProductionBandStripProps) {
  return (
    <BandChart
      title="Production capacity"
      metric="production_capacity"
      cohort={cohort}
      gameTicks={gameTicks}
      cursorTick={cursorTick}
      onHover={onHover}
      compact={compact}
    />
  );
}
