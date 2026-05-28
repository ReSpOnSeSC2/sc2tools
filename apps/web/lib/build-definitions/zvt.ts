// Zerg-vs-Terran matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Zerg-generic rules (zerg.ts) and fall through to
// them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

export const ZVT_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Zerg",
    matchup: "ZvT",
    name: "ZvT - 3 Hatch Ling Bane Muta",
    description:
      "Detected when three bases go down with a Baneling Nest and Spire, defending bio with Banelings and Zerglings while teching to Mutalisks -- the textbook ZvT macro style.",
  },
  {
    race: "Zerg",
    matchup: "ZvT",
    name: "ZvT - 2 Base Roach Ravager Timing",
    description:
      "Detected when a Roach Warren produces a wall of Roaches and Ravagers off two bases on a low drone count -- the ZvT roach/ravager pressure timing.",
  },
];
