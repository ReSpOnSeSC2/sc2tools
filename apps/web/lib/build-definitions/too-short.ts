// Catch-all per matchup for replays that ended in under 45 seconds,
// before any build order developed. Both the player and the opponent
// get this label so the data view stays consistent. Filterable via the
// analyzer's "Exclude too-short games" toggle in the FilterBar.
import type { BuildDefinition } from "../build-definitions";

export const TOO_SHORT_DEFINITIONS: ReadonlyArray<Omit<BuildDefinition, "id">> = [
  {
    race: "Protoss",
    matchup: "PvP",
    name: "PvP - Game Too Short",
    description:
      "Catch-all bucket for PvP replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Protoss",
    matchup: "PvT",
    name: "PvT - Game Too Short",
    description:
      "Catch-all bucket for PvT replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Protoss",
    matchup: "PvZ",
    name: "PvZ - Game Too Short",
    description:
      "Catch-all bucket for PvZ replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Terran",
    matchup: "TvP",
    name: "TvP - Game Too Short",
    description:
      "Catch-all bucket for TvP replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Terran",
    matchup: "TvT",
    name: "TvT - Game Too Short",
    description:
      "Catch-all bucket for TvT replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Terran",
    matchup: "TvZ",
    name: "TvZ - Game Too Short",
    description:
      "Catch-all bucket for TvZ replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Zerg",
    matchup: "ZvP",
    name: "ZvP - Game Too Short",
    description:
      "Catch-all bucket for ZvP replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Zerg",
    matchup: "ZvT",
    name: "ZvT - Game Too Short",
    description:
      "Catch-all bucket for ZvT replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
  {
    race: "Zerg",
    matchup: "ZvZ",
    name: "ZvZ - Game Too Short",
    description:
      "Catch-all bucket for ZvZ replays that ended in under 45 seconds (no build order developed). Both the player and the opponent get this label so the data view stays consistent. Filterable via the analyzer's 'Exclude too-short games' toggle.",
  },
];
