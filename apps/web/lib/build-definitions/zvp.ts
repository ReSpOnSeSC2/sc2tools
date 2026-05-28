// Zerg-vs-Protoss matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Zerg-generic rules (zerg.ts) and fall through to
// them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

export const ZVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Ling Bane Muta",
    description:
      "Detected when a Baneling Nest and Spire support Banelings and a wall of Zerglings -- the muta/ling/bane harass style vs Protoss.",
  },
];
