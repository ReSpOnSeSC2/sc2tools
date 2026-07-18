// Zerg-vs-Protoss matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Zerg-generic rules (zerg.ts) and fall through to
// them when no specific build matched. Descriptions are copied verbatim
// from core/build_definitions.py — the name strings are the join key
// between stored games and this catalog.
import type { BuildDefinition } from "../build-definitions";

export const ZVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - 8 Pool Rush",
    description:
      "Detected when the Spawning Pool starts before 0:55 into a wall of Zerglings on one base -- the cheese rush vs Protoss.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Ling Bane Bust",
    description:
      "Detected when an early Pool and Baneling Nest flood Banelings and Zerglings off two or fewer bases -- the bust through the Protoss wall.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - 2 Base Roach Ravager All-in",
    description:
      "Detected when a Roach Warren produces a wall of Roaches and Ravagers off two bases on a low drone count -- the ZvP roach/ravager all-in.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - 2 Base Nydus",
    description:
      "Detected when a Nydus Network goes down off two bases for a worm into the Protoss main -- the ZvP Nydus all-in.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Hydra Timing (3 Base)",
    description:
      "Detected when a Hydralisk Den fields a hydra wave off three bases -- the standard ZvP answer to Stargate openers.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Lurker Contain",
    description:
      "Detected when a Lurker Den enables a positional Lurker contain vs Protoss.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Ling Bane Muta",
    description:
      "Detected when a Baneling Nest and Spire support Banelings and a wall of Zerglings -- the muta/ling/bane harass style vs Protoss.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Mutalisk Harass",
    description:
      "Detected when a Spire into 6+ Mutalisks (no Baneling Nest) runs pure muta harass into the Protoss mineral lines.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Speedling Flood",
    description:
      "Detected when three bases pump 20+ Zerglings on a low drone count -- the ZvP ling-flood timing against a greedy third.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Hatch First Macro",
    description:
      "Detected when a greedy three-base economy (40+ Drones) opens hatch-first vs Protoss.",
  },
];
