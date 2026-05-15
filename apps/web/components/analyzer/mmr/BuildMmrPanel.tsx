"use client";

import { MmrStatsPanel } from "./MmrStatsPanel";

/**
 * Builds tab — "Win rate by MMR" chart. Plots one line per build
 * the streamer has played, X-axis is the MMR they were at when
 * playing it. Tells you whether each build is keeping up with your
 * climb (line stays flat at 50%+), holding you back (drops past a
 * bucket), or coming into its own at higher levels.
 *
 * Thin wrapper around ``MmrStatsPanel`` — the shared primitive
 * drives the same UX on the opponent-strategy cut. See that file
 * for the design rationale.
 */
export function BuildMmrPanel() {
  return (
    <MmrStatsPanel
      title="Win rate by MMR — your builds"
      subtitle="One line per build · X-axis is the MMR you were at when you played it · 50% reference is the coinflip baseline · Buckets with fewer games than the min-games gate are skipped so noisy small samples don't mislead."
      endpoint="/v1/mmr-stats/builds"
      seriesKey="build"
      seriesLabel="Builds"
      storageNamespace="analyzer.mmr.builds"
      emptyTitle="No MMR-tagged builds yet"
      emptySub="Charts populate as games ingest with both your MMR and the opponent's MMR. Older games without MMR data aren't bucketed."
    />
  );
}
