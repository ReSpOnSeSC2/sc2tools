"use client";

import { useMemo } from "react";
import { getUnitCost } from "@/lib/sc2-units";
import type { PatchEra } from "@/lib/meta";

export type UnitTradeSample = {
  selected: number;
  replays: { matchup: string; era: PatchEra | null;
    kills: { unit: string; target: string; count: number }[];
    losses: { unit: string; count: number }[] }[];
};

/** Price each observation in its replay's patch era before comparing trades. */
export function summarizeUnitTradeSample(sample: UnitTradeSample) {
  const totals = new Map<string, { unit: string; matchup: string; killed: number; lost: number; games: number; unknown: boolean }>();
  for (const replay of sample.replays) {
    const present = new Set<string>();
    const events: { unit: string; target?: string; count: number }[] = [...replay.losses, ...replay.kills];
    for (const event of events) {
      const key = `${replay.matchup}:${event.unit}`;
      const row = totals.get(key) ?? { unit: event.unit, matchup: replay.matchup, killed: 0, lost: 0, games: 0, unknown: false };
      const name = event.target ?? event.unit;
      const cost = getUnitCost(name, replay.era);
      const total = cost ? event.count * (cost.m + cost.g) : 0;
      if (event.target) row.killed += total;
      else row.lost += total;
      if (!cost) row.unknown = true;
      if (!present.has(key)) row.games++;
      present.add(key);
      totals.set(key, row);
    }
  }
  return [...totals.values()].filter(row => !row.unknown && row.killed > 0 && row.lost > 0 && row.games >= 3)
    .sort((a, b) => b.games - a.games || b.killed + b.lost - a.killed - a.lost)
    .slice(0, 8);
}

export function UnitTradeSampleCard({ sample }: { sample: UnitTradeSample }) {
  const rows = useMemo(() => summarizeUnitTradeSample(sample), [sample]);
  if (!rows.length) return <p className="text-caption text-text-muted">A unit needs measured losses or credited kills in at least three sampled games to appear here.</p>;
  return <section aria-label="Recorded unit trades" className="space-y-2">
    <p className="text-caption text-text-muted">Unit trades from {sample.replays.length} of the {sample.selected} sampled replays. Each ratio uses losses and attributed kills priced in the replay's patch era.</p>
    <ul className="grid gap-2 sm:grid-cols-2">
      {rows.map(row => <li key={`${row.matchup}:${row.unit}`} className="rounded-md border border-border p-2 text-caption">
        <strong>{row.unit}</strong> trade {(row.killed / row.lost).toFixed(1)}:1 in {row.matchup} ({row.games} games)
      </li>)}
    </ul>
  </section>;
}
