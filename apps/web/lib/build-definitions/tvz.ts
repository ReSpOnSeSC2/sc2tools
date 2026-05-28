// Terran-vs-Zerg matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Terran-generic rules (terran.ts) and fall through
// to them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

export const TVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 1-1-1 Banshee",
    description:
      "Detected when a Factory and Starport are built before any expansion and a Banshee reaches the field on one base -- the 1-base cloak-Banshee harass vs Zerg.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 3 Rax Marine",
    description:
      "Detected when 3+ Barracks off a single base produce a Marine flood with no Factory -- a gas-light Marine all-in vs Zerg.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - Reaper Hellion Expand",
    description:
      "Detected when a Reaper-first scout and early Hellions back a fast expansion before any air or mech-upgrade tech -- the standard economic Reaper/Hellion opener vs Zerg.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 2 Base Hellbat Thor",
    description:
      "Detected when an Armory and two Factories produce Thors behind a wall of Hellions/Hellbats off two bases -- the 2-base mech timing vs Zerg.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 2-1-1 Marine Hellbat Timing",
    description:
      "Detected when Armory-backed Hellbats and Marines push off two bases without a Thor -- the 2-1-1 marine/hellbat timing attack.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - Battlecruiser Mech",
    description:
      "Detected when a Fusion Core produces Battlecruisers as the late-game mech finisher vs Zerg.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - Hellion Liberator",
    description:
      "Detected when early Hellions plus a Liberator zone the Zerg's bases off two CCs -- the Hellion/Liberator harass opener.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 2-1-1 Marine Drop",
    description:
      "Detected when a Starport Medivac drop carries Marines off two bases -- the committed 2-base drop timing (not 3-CC macro).",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - Widow Mine Marine",
    description:
      "Detected when a Marine ball with 2+ Widow Mines and a Medivac runs mobile mine drops vs Zerg.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - 3 CC Bio",
    description:
      "Detected when three Command Centers are taken by 6:00 behind 3+ Barracks of Marine/Marauder with no mech tech (Armory / Fusion Core) -- the standard macro bio opening vs Zerg.",
  },
];
