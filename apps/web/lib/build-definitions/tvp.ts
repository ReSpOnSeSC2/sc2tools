import type { BuildDefinition } from "../build-definitions";

export const TVP_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - 1-1-1 One Base",
    description:
      "Detected when the player is Terran in TvP and a Barracks, Factory, and Starport are ALL built before the second Command Center -- and none of the three is proxied (they all sit inside the main). The classic 1-base 1-1-1 all-in vs Protoss: Cloak Banshee / Marine-Tank / Marine-Medivac-Tank pressure off a single base with no expansion.",
  },
];
