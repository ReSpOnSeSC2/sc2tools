import type { Race } from "@/lib/ladder/vods";

/** The text colour of each race, as the ladder pages show it. */
export const RACE_TEXT: Record<Race, string> = {
  terran: "text-race-terran",
  zerg: "text-race-zerg",
  protoss: "text-race-protoss",
  random: "text-race-random",
};
