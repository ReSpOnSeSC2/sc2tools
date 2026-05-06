"use client";

import { PerGameInspector } from "./PerGameInspector";

/**
 * Activity tab — per-game inspector.
 *
 * Pick a replay from the list on the left and drill into its resources,
 * army, APM/SPM, and (Protoss) chrono allocation. The previous
 * activity-by-hour / day-of-week aggregates lived here but the panel
 * subtitle always promised per-game charts; this surface is now the
 * thing the subtitle described.
 */
export function ActivityCharts() {
  return <PerGameInspector />;
}
