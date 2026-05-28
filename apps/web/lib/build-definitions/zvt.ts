// Zerg-vs-Terran matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Zerg-generic rules (zerg.ts) and fall through to
// them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

const zvt = (name: string, description: string): Omit<BuildDefinition, "id"> => ({
  race: "Zerg",
  matchup: "ZvT",
  name,
  description,
});

export const ZVT_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  zvt(
    "ZvT - Ling Bane Bust",
    "Detected when an early Pool and Baneling Nest flood Banelings and Zerglings off two or fewer bases -- the ZvT ling/bane bust.",
  ),
  zvt(
    "ZvT - 2 Base Roach Ravager Timing",
    "Detected when a Roach Warren produces a wall of Roaches and Ravagers off two bases on a low drone count -- the ZvT roach/ravager pressure timing.",
  ),
  zvt(
    "ZvT - 2 Base Nydus",
    "Detected when a Nydus Network goes down off two bases for a drop into the Terran main -- the ZvT Nydus all-in.",
  ),
  zvt(
    "ZvT - Mass Queen Defensive",
    "Detected when a queen-heavy defence (6+ Queens) holds with no Roach/Baneling/Spire aggression -- the ZvT queen-walk / defensive style.",
  ),
  zvt(
    "ZvT - Lurker Contain",
    "Detected when a Lurker Den enables a positional Lurker contain vs Terran.",
  ),
  zvt(
    "ZvT - 3 Hatch Ling Bane Muta",
    "Detected when three bases go down with a Baneling Nest and Spire, defending bio with Banelings and Zerglings while teching to Mutalisks -- the textbook ZvT macro style.",
  ),
  zvt(
    "ZvT - Mass Muta Harass",
    "Detected when a Spire into 6+ Mutalisks (no Baneling Nest) runs pure muta harass vs Terran.",
  ),
  zvt(
    "ZvT - Roach Hydra",
    "Detected when a Roach Warren and Hydralisk Den field a roach/hydra ground army vs Terran.",
  ),
  zvt(
    "ZvT - 3 Base Ling Flood",
    "Detected when three bases pump 20+ Zerglings on a low drone count -- the ZvT ling-flood timing.",
  ),
  zvt(
    "ZvT - Hatch First Macro",
    "Detected when a greedy three-base economy (40+ Drones) opens hatch-first vs Terran.",
  ),
];
