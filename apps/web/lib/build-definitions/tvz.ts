// Terran-vs-Zerg matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Terran-generic rules (terran.ts) and fall through
// to them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

export const TVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 3 CC Bio",
    description:
      "Detected when three Command Centers are taken by 6:00 behind 3+ Barracks of Marine/Marauder with no mech tech (Armory / Fusion Core) -- the standard macro bio opening vs Zerg.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 2 Base Hellbat Thor",
    description:
      "Detected when an Armory and two Factories produce Thors behind a wall of Hellions/Hellbats off two bases -- the 2-base mech timing vs Zerg.",
  },
];
