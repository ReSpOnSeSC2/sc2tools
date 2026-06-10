"use client";

import { MacroSummaryCard } from "./MacroSummaryCard";
import { PerGameInspector } from "./charts/PerGameInspector";

/**
 * Macro tab — the macro-efficiency surface.
 *
 * Header card: average score, most expensive recurring leaks, and a
 * one-click backfill for games that predate macro scoring. Below it,
 * the per-game inspector: pick any replay and drill into its score,
 * leaks, resources, army, APM/SPM, and (Protoss) chrono allocation.
 */
export function MacroTab() {
  return (
    <div className="space-y-4">
      <MacroSummaryCard />
      <PerGameInspector />
    </div>
  );
}
