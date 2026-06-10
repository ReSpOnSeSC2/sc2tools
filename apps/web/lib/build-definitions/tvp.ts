// Terran-vs-Protoss matchup-specific build definitions. Detected by the
// per-matchup detectors in core/strategy_detector_matchups.py; they take
// precedence over the Terran-generic rules (terran.ts) and fall through
// to them when no specific build matched. A greedy fast-3-CC opening
// without the bio commitment stays on the generic `Terran - Fast 3 CC`
// label. Descriptions are copied verbatim from core/build_definitions.py
// — the name strings are the join key between stored games and this
// catalog.
import type { BuildDefinition } from "../build-definitions";

export const TVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Proxy 4 Rax Reaper",
    description:
      "Detected when four Barracks (at least one proxied near the enemy) flood Reapers -- the all-in proxy reaper rush vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Proxy Marauder",
    description:
      "Detected when a proxied Barracks pumps Marauders into the Protoss wall -- the proxy Marauder rush vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Cyclone Push",
    description:
      "Detected when an early Factory produces Cyclones off two or fewer bases -- the lock-on Cyclone pressure vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - 1-1-1 Cloak Banshee",
    description:
      "Detected when a Factory and Starport are built before any expansion and a Banshee reaches the field on one base -- the 1-base cloak-Banshee harass vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - 3 Rax Marine",
    description:
      "Detected when 3+ Barracks off one base flood Marines with no Factory -- a gas-light Marine all-in vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Battlecruiser Rush",
    description:
      "Detected when a fast Fusion Core lands Battlecruisers -- the Battlecruiser rush vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Tank/Thor Mech",
    description:
      "Detected when an Armory backs Thors and Siege Tanks -- the positional mech composition vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Widow Mine Drop",
    description:
      "Detected when a Marine ball with 2+ Widow Mines and a Medivac runs mobile mine drops into the Protoss mineral lines.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - 2-1-1 Reaper Expand",
    description:
      "Detected when a Reaper-first scout takes a single expansion (no fast 3rd CC) and adds a Factory + Starport for the Medivac-drop / Stim bio timing off two bases vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - 2 Base Tank Push",
    description:
      "Detected when a Starport build fields Siege Tanks behind a Marine ball off two bases -- the classic tank-push timing vs Protoss.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Fast 3 CC Bio",
    description:
      "Detected when three Command Centers are taken by 6:00 behind 3+ Barracks of Marine/Marauder with no mech tech -- the greedy macro bio opening vs Protoss.",
  },
];
