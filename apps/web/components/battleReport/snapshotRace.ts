const NAMES: Record<string, string> = { p: "Protoss", protoss: "Protoss", t: "Terran", terran: "Terran", z: "Zerg", zerg: "Zerg", r: "Random", random: "Random" };

export function snapshotRace(race: string | null | undefined, side: "me" | "opp") {
  const name = NAMES[race?.trim().toLowerCase() ?? ""];
  return { name: name ?? "Unknown race", token: name ? `--race-${name.toLowerCase()}` : side === "me" ? "--player-you" : "--player-opp" };
}
