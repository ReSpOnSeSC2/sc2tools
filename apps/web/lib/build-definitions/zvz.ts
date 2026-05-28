// Zerg-vs-Zerg matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Zerg-generic rules (zerg.ts) and fall through to
// them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

export const ZVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Zerg",
    matchup: "ZvZ",
    name: "ZvZ - 12 Pool Speedling",
    description:
      "Detected when the Spawning Pool starts before 0:55 into a wall of Zerglings on one base -- the aggressive ZvZ speedling opener.",
  },
  {
    race: "Zerg",
    matchup: "ZvZ",
    name: "ZvZ - Roach Aggression",
    description:
      "Detected when a Roach Warren produces a wall of Roaches off two bases -- the standard ZvZ roach pressure / all-in.",
  },
];
