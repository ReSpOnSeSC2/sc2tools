/**
 * Race accent lookup for the H2H surface. Maps a race code/name to
 * the dark-theme hex value already used in MatchupOverTimeChart and
 * the existing `raceColour` helper, so charts in the H2H section
 * blend in with the rest of the app even though they take the race
 * accent as an explicit prop (Recharts SVG primitives need a hex
 * string, not a CSS variable).
 *
 * Per the design system: race accents NEVER carry W/L meaning —
 * they are used only for area fills, dot strokes, and legend chips.
 */

export type RaceLetter = "T" | "P" | "Z" | "R" | "U";

const ACCENT: Record<RaceLetter, string> = {
  P: "#7c8cff",
  T: "#ff6b6b",
  Z: "#a78bfa",
  R: "#9aa3b2",
  U: "#9aa3b2",
};

export function raceAccent(race?: string | null): string {
  return ACCENT[normalizeRace(race)];
}

export function normalizeRace(race?: string | null): RaceLetter {
  const head = (race || "").trim().charAt(0).toUpperCase();
  if (head === "T" || head === "P" || head === "Z" || head === "R") return head;
  return "U";
}

export function raceFullName(letter: RaceLetter): string {
  switch (letter) {
    case "T":
      return "Terran";
    case "P":
      return "Protoss";
    case "Z":
      return "Zerg";
    case "R":
      return "Random";
    default:
      return "Unknown";
  }
}
