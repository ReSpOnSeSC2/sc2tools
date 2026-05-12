/**
 * Race utilities — canonical Race / VsRace types, normalization,
 * matchup labels, and tailwind class helpers tied to the
 * --race-* CSS tokens declared in globals.css.
 *
 * Centralised so the builds page, opponent profile, and settings
 * panels render identical race chrome.
 */
import type { IconKind } from "@/lib/sc2-icons";

export type Race = "Protoss" | "Terran" | "Zerg" | "Random";

export type VsRace = Race | "Any";

export const RACES: ReadonlyArray<Race> = [
  "Protoss",
  "Terran",
  "Zerg",
  "Random",
];

export const VS_RACES: ReadonlyArray<VsRace> = [...RACES, "Any"];

const VALID_RACES = new Set<string>(RACES);
const VALID_VS_RACES = new Set<string>(VS_RACES);

/** Coerce a free-form string ("P", "Protoss", null) to a strict Race. */
export function coerceRace(input: unknown, fallback: Race = "Random"): Race {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  if (VALID_RACES.has(trimmed)) return trimmed as Race;
  switch (trimmed[0]?.toUpperCase()) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    case "R":
      return "Random";
    default:
      return fallback;
  }
}

export function coerceVsRace(input: unknown): VsRace {
  if (typeof input !== "string") return "Any";
  const trimmed = input.trim();
  if (VALID_VS_RACES.has(trimmed)) return trimmed as VsRace;
  if (!trimmed) return "Any";
  switch (trimmed[0]?.toUpperCase()) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    case "R":
      return "Random";
    default:
      return "Any";
  }
}

/** "P", "T", "Z", "R" — short race letter. */
export function raceLetter(r: Race): "P" | "T" | "Z" | "R" {
  switch (r) {
    case "Protoss":
      return "P";
    case "Terran":
      return "T";
    case "Zerg":
      return "Z";
    case "Random":
      return "R";
  }
}

/** Compose a matchup label like "PvT" / "PvZ" / "ZvP". */
export function matchupLabel(my: Race, vs: VsRace): string {
  if (vs === "Any") return raceLetter(my);
  return `${raceLetter(my)}v${raceLetter(vs)}`;
}

/**
 * Standard six-faction matchup chips used in filter bars. Random and
 * mirrors derived from the user's current race could be added later;
 * this list intentionally focuses on the most-played pairings.
 */
export const COMMON_MATCHUPS: ReadonlyArray<{ my: Race; vs: Race }> = [
  { my: "Protoss", vs: "Protoss" },
  { my: "Protoss", vs: "Terran" },
  { my: "Protoss", vs: "Zerg" },
  { my: "Terran", vs: "Protoss" },
  { my: "Terran", vs: "Terran" },
  { my: "Terran", vs: "Zerg" },
  { my: "Zerg", vs: "Protoss" },
  { my: "Zerg", vs: "Terran" },
  { my: "Zerg", vs: "Zerg" },
];

/** Map a Race to the lowercase sc2-icons race key. */
export function raceIconName(r: Race): string {
  return r.toLowerCase();
}

/**
 * Infer the owning race from a build name when the data layer didn't
 * supply one. Handles three naming conventions emitted by the analyzer
 * detectors and the bundled BUILD_DEFINITIONS catalog:
 *
 *   "PvP - 1 Gate Expand"     → "Protoss"  (matchup prefix — owning race is the left letter)
 *   "Protoss - 4 Gate Rush"   → "Protoss"  (explicit race prefix)
 *   "Unclassified - Zerg"     → "Zerg"     (race suffix on sentinel rows)
 *
 * Returns null when no race can be deduced; callers decide whether to
 * fall back to "Random" (which renders as a generic dice icon) or hide
 * the race chrome entirely.
 */
export function inferRaceFromBuildName(name: string): Race | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const matchup = /^([PpTtZz])v[PpTtZzXxRr]\b/.exec(trimmed);
  if (matchup) {
    switch (matchup[1].toUpperCase()) {
      case "P":
        return "Protoss";
      case "T":
        return "Terran";
      case "Z":
        return "Zerg";
    }
  }
  if (/^Protoss\b/i.test(trimmed)) return "Protoss";
  if (/^Terran\b/i.test(trimmed)) return "Terran";
  if (/^Zerg\b/i.test(trimmed)) return "Zerg";
  if (/-\s*Protoss\b/i.test(trimmed)) return "Protoss";
  if (/-\s*Terran\b/i.test(trimmed)) return "Terran";
  if (/-\s*Zerg\b/i.test(trimmed)) return "Zerg";
  return null;
}

export const RACE_ICON_KIND: IconKind = "race";

/**
 * Tailwind classes for race-tinted UI fragments. Tokens live under
 * --race-* in globals.css so theme switches keep contrast right.
 */
export interface RaceTintClasses {
  /** Solid text colour, e.g. for matchup label glyphs. */
  text: string;
  /** Soft tint background — pairs with `text`. */
  bg: string;
  /** Border that matches the tint. */
  border: string;
  /** Strong solid background — for filled chips / left rail. */
  rail: string;
  /** Halo glow utility — pairs with the rail for hero cards. */
  glow: string;
}

const TINT: Record<Race, RaceTintClasses> = {
  Protoss: {
    text: "text-race-protoss",
    bg: "bg-race-protoss/12",
    border: "border-race-protoss/40",
    rail: "bg-race-protoss",
    glow: "shadow-[0_0_24px_rgb(var(--race-protoss)/0.30)]",
  },
  Terran: {
    text: "text-race-terran",
    bg: "bg-race-terran/12",
    border: "border-race-terran/40",
    rail: "bg-race-terran",
    glow: "shadow-[0_0_24px_rgb(var(--race-terran)/0.30)]",
  },
  Zerg: {
    text: "text-race-zerg",
    bg: "bg-race-zerg/12",
    border: "border-race-zerg/40",
    rail: "bg-race-zerg",
    glow: "shadow-[0_0_24px_rgb(var(--race-zerg)/0.30)]",
  },
  Random: {
    text: "text-race-random",
    bg: "bg-race-random/12",
    border: "border-race-random/40",
    rail: "bg-race-random",
    glow: "",
  },
};

export function raceTint(r: Race): RaceTintClasses {
  return TINT[r];
}
