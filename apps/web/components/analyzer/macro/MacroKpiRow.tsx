"use client";

import { formatApm, type GameApm } from "@/lib/apm";
import type { BreakdownRaw } from "./MacroBreakdownPanel.types";
import { SpendingQuotientStat } from "./SpendingQuotientStat";

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
        termId="spending-quotient"
      />
      <SpendingQuotientStat
        label="Supply blocked"
        value={raw.supply_blocked_seconds}
        tone={(raw.supply_blocked_seconds || 0) > 10 ? "warning" : "neutral"}
        unit="s"
        hint="Lower is better"
        termId="supply-blocked"
      />
      <SpendingQuotientStat
        label="Float spikes"
        value={raw.mineral_float_spikes}
        tone={(raw.mineral_float_spikes || 0) > 0 ? "warning" : "neutral"}
        hint="Samples >800 minerals from 4:00"
        termId="float-spikes"
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
        termId="apm"
      />
    </div>
  );
}
