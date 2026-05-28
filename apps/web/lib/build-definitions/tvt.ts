// Terran-vs-Terran matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Terran-generic rules (terran.ts) and fall through
// to them when no specific build matched.
import type { BuildDefinition } from "../build-definitions";

const tvt = (name: string, description: string): Omit<BuildDefinition, "id"> => ({
  race: "Terran",
  matchup: "TvT",
  name,
  description,
});

export const TVT_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  tvt(
    "TvT - Proxy 4 Rax Reaper",
    "Detected when four Barracks (at least one proxied near the enemy) flood Reapers -- the all-in proxy reaper rush in TvT.",
  ),
  tvt(
    "TvT - Proxy Marauder",
    "Detected when a proxied Barracks pumps Marauders into the enemy base -- the TvT proxy Marauder rush.",
  ),
  tvt(
    "TvT - Cyclone Push",
    "Detected when an early Factory produces Cyclones off two or fewer bases -- the TvT Cyclone push.",
  ),
  tvt(
    "TvT - 1-1-1 Cloak Banshee",
    "Detected when a Factory and Starport are built before any expansion and a Banshee reaches the field on one base -- the classic 1-1-1 cloak-Banshee harass.",
  ),
  tvt(
    "TvT - Banshee into Raven",
    "Detected when cloak Banshees are backed by a Raven for detection and anti-air -- the TvT Banshee/Raven harass.",
  ),
  tvt(
    "TvT - Battlecruiser Rush",
    "Detected when a fast Fusion Core lands Battlecruisers -- the TvT Battlecruiser rush.",
  ),
  tvt(
    "TvT - Tank/Thor Mech",
    "Detected when an Armory backs Thors and Siege Tanks -- the positional TvT mech composition.",
  ),
  tvt(
    "TvT - Reaper Expand into Tank/Viking",
    "Detected when a Reaper-first scout is followed by a single expansion and then Siege Tanks behind Vikings -- the standard TvT positional macro opener that masses tanks for the air-controlled contain.",
  ),
  tvt(
    "TvT - 2-1-1 Marine Tank",
    "Detected when a Starport build fields Siege Tanks and Marines off two bases (no Viking) -- the TvT bio-tank timing.",
  ),
  tvt(
    "TvT - 3 Rax Marine",
    "Detected when 3+ Barracks off one base flood Marines with no Factory -- a gas-light TvT Marine all-in.",
  ),
  tvt(
    "TvT - Mass Viking Air",
    "Detected when a Viking-heavy air composition dominates the skies -- the TvT mass-Viking late game.",
  ),
];
