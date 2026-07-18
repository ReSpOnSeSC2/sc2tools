// Zerg-vs-Zerg matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Zerg-generic rules (zerg.ts) and fall through to
// them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

const zvz = (name: string, description: string): Omit<BuildDefinition, "id"> => ({
  race: "Zerg",
  matchup: "ZvZ",
  name,
  description,
});

export const ZVZ_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  zvz(
    "ZvZ - 8 Pool into Baneling",
    "Detected when a sub-55s Pool goes straight into a Baneling Nest and Banelings -- the early ZvZ baneling all-in.",
  ),
  zvz(
    "ZvZ - 8 Pool Speedling",
    "Detected when the Spawning Pool starts before 0:55 into a wall of Zerglings on one base -- the aggressive ZvZ speedling opener.",
  ),
  zvz(
    "ZvZ - Ling Bane All-in",
    "Detected when a Baneling Nest floods Banelings and Zerglings off two or fewer bases -- the ZvZ ling/bane all-in.",
  ),
  zvz(
    "ZvZ - Roach Ravager",
    "Detected when a Roach Warren fields Roaches and Ravagers -- the ZvZ roach/ravager style.",
  ),
  zvz(
    "ZvZ - Roach Aggression",
    "Detected when a Roach Warren produces a wall of Roaches off two bases -- the standard ZvZ roach pressure / all-in.",
  ),
  zvz(
    "ZvZ - 2 Base Nydus",
    "Detected when a Nydus Network goes down off two bases -- the ZvZ Nydus all-in.",
  ),
  zvz(
    "ZvZ - Mutalisk vs Mutalisk",
    "Detected when a Spire into 6+ Mutalisks creates the classic ZvZ muta war.",
  ),
  zvz(
    "ZvZ - Hatch First Muta",
    "Detected when a hatch-first economy (slow Pool) teches to a Spire -- the ZvZ hatch-first muta.",
  ),
  zvz(
    "ZvZ - Zergling Flood",
    "Detected when 20+ Zerglings flood on a low drone count -- the ZvZ ling flood.",
  ),
  zvz(
    "ZvZ - Drone Macro (Hatch First)",
    "Detected when a greedy hatch-first economy (30+ Drones, slow Pool) drones up in ZvZ.",
  ),
];
