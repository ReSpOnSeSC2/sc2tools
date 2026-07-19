// Loyalty-rank ladders — one 10-step unit progression per race. The
// streamer picks the theme in Settings (multichat prefs
// ``engagement.rankRace``); the supporter-wall widget maps each
// viewer's LEVEL to a name client-side, so switching race re-themes
// everyone instantly with no stored-data migration. The API's
// engagement service only ever persists numeric XP/levels (its
// ``rank`` field is a Protoss-named fallback for consumers without
// config access).

export type RankRace = "protoss" | "terran" | "zerg";

export const RANK_RACES: readonly RankRace[] = ["protoss", "terran", "zerg"];

export const RANK_LADDERS: Record<RankRace, readonly string[]> = {
  protoss: [
    "Probe",
    "Zealot",
    "Adept",
    "Stalker",
    "Immortal",
    "High Templar",
    "Archon",
    "Colossus",
    "Carrier",
    "Mothership",
  ],
  terran: [
    "SCV",
    "Marine",
    "Marauder",
    "Reaper",
    "Hellion",
    "Siege Tank",
    "Liberator",
    "Ghost",
    "Thor",
    "Battlecruiser",
  ],
  zerg: [
    "Larva",
    "Drone",
    "Zergling",
    "Roach",
    "Hydralisk",
    "Mutalisk",
    "Lurker",
    "Ultralisk",
    "Brood Lord",
    "Swarm Host",
  ],
};

export const RANK_RACE_LABEL: Record<RankRace, string> = {
  protoss: "Protoss (Probe → Mothership)",
  terran: "Terran (SCV → Battlecruiser)",
  zerg: "Zerg (Larva → Swarm Host)",
};

export function sanitizeRankRace(raw: unknown): RankRace {
  return RANK_RACES.includes(raw as RankRace) ? (raw as RankRace) : "protoss";
}

/** Rank name for a level (clamped to the ladder's top). */
export function rankNameFor(race: RankRace, level: number): string {
  const ladder = RANK_LADDERS[race];
  const idx = Math.min(
    ladder.length - 1,
    Math.max(0, Math.round(Number(level) || 0)),
  );
  return ladder[idx];
}
