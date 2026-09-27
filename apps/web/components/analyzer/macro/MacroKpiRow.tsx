"use client";

import { formatApm, type GameApm } from "@/lib/apm";
import type { BreakdownRaw } from "./MacroBreakdownPanel.types";
import { SpendingQuotientStat } from "./SpendingQuotientStat";

const APM_EXPLANATION =
  "Actions per minute, counted like StarCraft II's in-game APM: every command, selection and control-group action, averaged over the game. Switch the Match timeline to APM to see how your pace moved.";
const APM_MISSING_EXPLANATION =
  "APM is measured for games synced with agent 0.17.2 or newer. Use Recompute (or Re-sync) to add it to this game.";

/**
 * The macro breakdown's headline tiles: spending quotient, supply
 * blocked, float spikes and APM. Two per row on phones, one row from
 * ``md`` up.
 */
export function MacroKpiRow({
  raw,
  apm,
  apmLoading,
}: {
  raw: BreakdownRaw;
  /** The game's trusted APM (lib/apm.ts); null when not measured. */
  apm: GameApm | null;
  apmLoading: boolean;
}) {
  const oppApm = apm?.opp?.avg ?? null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <SpendingQuotientStat
        label="Spending Quotient"
        value={typeof raw.sq === "number" ? raw.sq : null}
        tone="cyan"
        glow
        decimals={1}
        explanation="SQ blends income and unspent resources into a single ladder-tier metric. 80+ is Master/Pro pacing; 70+ is solid Diamond."
      />
      <SpendingQuotientStat
        label="Supply blocked"
        value={raw.supply_blocked_seconds}
        tone={(raw.supply_blocked_seconds || 0) > 10 ? "warning" : "neutral"}
        unit="s"
        hint="Lower is better"
        explanation="Total seconds your supply was capped — production stalls during these windows, costing units and tempo."
      />
      <SpendingQuotientStat
        label="Float spikes"
        value={raw.mineral_float_spikes}
        tone={(raw.mineral_float_spikes || 0) > 0 ? "warning" : "neutral"}
        hint="Samples > 800 minerals after 4:00"
        explanation="How many mid-game samples showed a sustained mineral surplus. Banked minerals that aren't building units delay your next push."
      />
      <SpendingQuotientStat
        label="APM"
        value={apm?.me.avg ?? null}
        hint={
          oppApm !== null
            ? `Opponent ${formatApm(oppApm)}`
            : apm === null && !apmLoading
              ? "Not measured for this game"
              : undefined
        }
        explanation={apm ? APM_EXPLANATION : APM_MISSING_EXPLANATION}
      />
    </div>
  );
}
