"use client";

import { MmrStatsPanel } from "./MmrStatsPanel";

/**
 * Strategies tab — "Win rate by MMR" chart. Plots one line per
 * detected opponent strategy, X-axis is the opponent's MMR at the
 * time of the match. Surfaces which opponent openings are scariest
 * at a given league: a 12-pool that wins 70% at 4000 MMR but
 * collapses to 40% at 5000 MMR tells you the same opening reads
 * differently as you climb.
 *
 * Thin wrapper around ``MmrStatsPanel`` — the shared primitive
 * drives the same UX on the my-build cut. See that file for the
 * design rationale.
 */
export function StrategyMmrPanel() {
  return (
    <MmrStatsPanel
      title="Win rate by MMR — opponent strategies"
      subtitle="One line per opponent strategy · X-axis is the opponent's MMR · 50% reference is the coinflip baseline · Buckets with fewer games than the min-games gate are skipped so noisy small samples don't mislead."
      endpoint="/v1/mmr-stats/strategies"
      seriesKey="strategy"
      seriesLabel="Strategies"
      storageNamespace="analyzer.mmr.strategies"
      emptyTitle="No MMR-tagged matchups yet"
      emptySub="Charts populate as games ingest with both your MMR and the opponent's MMR. Older games without MMR data aren't bucketed."
    />
  );
}
