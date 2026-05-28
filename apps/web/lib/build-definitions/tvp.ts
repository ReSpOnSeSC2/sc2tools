// Terran-vs-Protoss matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Terran-generic rules (terran.ts) and fall through
// to them when no specific build matched. A greedy fast-3-CC macro stays
// on the generic `Terran - Fast 3 CC` label.
import type { BuildDefinition } from "../build-definitions";

export const TVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Proxy 4 Rax Reaper",
    description:
      "Detected when four Barracks (at least one proxied near the enemy) flood Reapers -- the all-in proxy reaper rush vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - 2-1-1 Reaper Expand",
    description:
      "Detected when a Reaper-first scout takes a single expansion (no fast 3rd CC) and adds a Factory + Starport for the Medivac-drop / Stim bio timing off two bases vs Protoss.",
  },
];
