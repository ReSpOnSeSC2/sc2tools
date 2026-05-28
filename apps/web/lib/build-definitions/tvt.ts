// Terran-vs-Terran matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Terran-generic rules (terran.ts) and fall through
// to them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

export const TVT_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Terran",
    matchup: "TvT",
    name: "TvT - Reaper Expand into Tank/Viking",
    description:
      "Detected when a Reaper-first scout is followed by a single expansion and then Siege Tanks behind Vikings -- the standard TvT positional macro opener that masses tanks for the air-controlled contain.",
  },
  {
    race: "Terran",
    matchup: "TvT",
    name: "TvT - 1-1-1 Cloak Banshee",
    description:
      "Detected when a Factory and Starport are built before any expansion and a Banshee reaches the field on one base -- the classic 1-1-1 cloak-Banshee harass.",
  },
];
