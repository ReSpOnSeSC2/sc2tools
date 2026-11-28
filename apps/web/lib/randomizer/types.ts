/**
 * Build-order randomizer — shared types.
 *
 * The randomizer lets a streamer curate, per matchup, a pool of build
 * orders (drawn from the bundled BUILD_DEFINITIONS catalog and their
 * own custom builds) and have one picked at random — equal chance by
 * default, optional per-build weights. The chosen build is revealed on
 * stream via one of several animated styles.
 *
 * The persisted config (see `config.ts`) stores the resolved build
 * names + races inline so the OBS overlay widget — which authenticates
 * only with an overlay token and can't refetch the user's custom
 * builds — is fully self-contained from the `overlay:config` snapshot.
 */
import type { Race } from "@/lib/race";

/** The nine real matchups, streamer-perspective (my race vs theirs). */
export const MATCHUPS = [
  "PvP",
  "PvT",
  "PvZ",
  "TvP",
  "TvT",
  "TvZ",
  "ZvP",
  "ZvT",
  "ZvZ",
] as const;

export type MatchupKey = (typeof MATCHUPS)[number];

/** Animated reveal styles. One is chosen at random per spin. */
export const REVEAL_STYLES = [
  "case",
  "slot",
  "gacha",
  "battle",
  "wheel",
  "fighter",
  "race",
  "sumo",
  "asteroid",
  "swarm",
  "claw",
] as const;

export type RevealStyle = (typeof REVEAL_STYLES)[number];

/** Opening-unit reveal styles. One is chosen with each unit draw. */
export const UNIT_REVEAL_STYLES = [
  "warp-gate",
  "psi-draft",
  "power-surge",
] as const;

export type UnitRevealStyle = (typeof UNIT_REVEAL_STYLES)[number];

/** The race a matchup's first letter names: the streamer's own. */
export type PlayedRace = "Protoss" | "Terran" | "Zerg";

/** Protoss Gateway units supported by the opening-unit randomizer. */
export const GATEWAY_UNIT_IDS = [
  "zealot",
  "stalker",
  "sentry",
  "adept",
] as const;

/**
 * Terran and Zerg units the opening draw knows: every unit a Terran or Zerg
 * pre-made build is named for that one production structure makes
 * (`openingUnitPools.ts` derives each matchup's own list from them).
 * Ids are the shipped icon file names.
 */
export const TERRAN_UNIT_IDS = [
  "marine",
  "reaper",
  "marauder",
  "hellion",
  "widowmine",
  "siegetank",
  "cyclone",
  "viking",
  "liberator",
  "banshee",
  "raven",
] as const;

export const ZERG_UNIT_IDS = [
  "zergling",
  "queen",
  "baneling",
  "roach",
  "ravager",
  "hydralisk",
  "lurker",
  "mutalisk",
] as const;

export type GatewayUnitId = (typeof GATEWAY_UNIT_IDS)[number];
export type TerranUnitId = (typeof TERRAN_UNIT_IDS)[number];
export type ZergUnitId = (typeof ZERG_UNIT_IDS)[number];
export type OpeningUnitId = GatewayUnitId | TerranUnitId | ZergUnitId;

/** Each race's units in their canonical (display and draw) order. */
export const OPENING_UNIT_IDS: Readonly<Record<PlayedRace, readonly OpeningUnitId[]>> = {
  Protoss: GATEWAY_UNIT_IDS,
  Terran: TERRAN_UNIT_IDS,
  Zerg: ZERG_UNIT_IDS,
};

/** One unit or two: one per Gateway, or per building of a two-building opener. */
export type GatewayCount = 1 | 2;

/** One selected unit and its relative custom weight. */
export interface WeightedOpeningUnit {
  id: OpeningUnitId;
  weight: number;
}

/** Settings for one opening draw: a build's own, or its matchup's. */
export interface OpeningUnitsConfig {
  /**
   * How many units to draw. Stored as `gateCount` since Protoss builds first
   * saved it, so older settings read unchanged.
   */
  gateCount: GatewayCount;
  /** Off means every selected unit has equal odds. */
  useCustomWeights: boolean;
  /** Presence in this list means selected. */
  units: WeightedOpeningUnit[];
}

/** Where a build came from. */
export type BuildSource = "catalog" | "custom";

/** A single build in a matchup's randomizer pool. */
export interface RandomizerBuild {
  /** Unique id within the matchup pool (catalog slug or `custom:<slug>`). */
  id: string;
  /** Display name shown in the reveal. */
  name: string;
  /** Owning race (left side of the matchup) — drives tinting + icon. */
  race: Race;
  source: BuildSource;
  /**
   * Raw weight (relative). Only consulted when the matchup has
   * `useCustomWeights` on; otherwise every build is equal-chance.
   */
  weight: number;
  /**
   * The unit draw that follows this build. A Terran or Zerg build saved
   * without one draws with its matchup's `units`.
   */
  openingUnits?: OpeningUnitsConfig;
}

/** Per-matchup randomizer settings. */
export interface MatchupConfig {
  /** "Draw a build order": a build is picked from `builds`. */
  enabled: boolean;
  /** Opt-in: honour `build.weight` instead of equal chance. */
  useCustomWeights: boolean;
  /**
   * "Draw opening units". Independent of `enabled` from config version 3;
   * an older config only drew units after a build (see `config.ts`).
   */
  unitRandomizerEnabled: boolean;
  builds: RandomizerBuild[];
  /**
   * The matchup's own unit draw: used when no build is drawn, and by builds
   * without their own. Absent until set up, which draws no units.
   */
  units?: OpeningUnitsConfig;
}

/** Reveal sound-effect settings. */
export interface RandomizerSound {
  enabled: boolean;
  /** 0..1 master volume. */
  volume: number;
}

/**
 * Full randomizer config — one entry per matchup. Version 3 made the build
 * and unit draws independent switches.
 */
export interface RandomizerConfig {
  rollOnDesktop?: boolean;
  version: 3;
  matchups: Record<MatchupKey, MatchupConfig>;
  sound: RandomizerSound;
}

/** Result of one opening-unit draw. */
export interface OpeningUnitsOutcome {
  /** Whose units: picks the wording ("Gate 1" is Protoss only). */
  race: PlayedRace;
  gateCount: GatewayCount;
  /** One pick per Gateway or building. Picks are independent and may repeat. */
  picks: OpeningUnitId[];
  style: UnitRevealStyle;
  /** Eligible selected units, in display order. */
  pool: WeightedOpeningUnit[];
  /** Normalized landing probabilities, parallel to `pool`. */
  probabilities: number[];
}

/** Result of a single build spin. */
export interface SpinOutcome {
  matchup: MatchupKey;
  winner: RandomizerBuild;
  style: RevealStyle;
  /** The pool that was eligible, in display order. */
  pool: RandomizerBuild[];
  /** Normalized landing probabilities, parallel to `pool`. 0..1. */
  probabilities: number[];
}

/** One game's draw: a build, opening units, or both, in that order. */
export interface GameDraw {
  matchup: MatchupKey;
  /** Null when the matchup's build draw is off. */
  build: SpinOutcome | null;
  /** Null when the unit draw is off or has nothing to draw from. */
  units: OpeningUnitsOutcome | null;
}

const MATCHUP_SET = new Set<string>(MATCHUPS);

export function isMatchupKey(value: unknown): value is MatchupKey {
  return typeof value === "string" && MATCHUP_SET.has(value);
}

/** Split a matchup key into its component races. */
export function matchupRaces(m: MatchupKey): { my: Race; vs: Race } {
  return { my: raceFromLetter(m[0]), vs: raceFromLetter(m[2]) };
}

/** The streamer's race in a matchup. */
export function playedRace(m: MatchupKey): PlayedRace {
  return m[0] === "P" ? "Protoss" : m[0] === "T" ? "Terran" : "Zerg";
}

const UNIT_ID_SETS: Readonly<Record<PlayedRace, ReadonlySet<string>>> = {
  Protoss: new Set(GATEWAY_UNIT_IDS),
  Terran: new Set(TERRAN_UNIT_IDS),
  Zerg: new Set(ZERG_UNIT_IDS),
};

/** True for one of `race`'s opening units. */
export function isOpeningUnitId(value: unknown, race: PlayedRace): value is OpeningUnitId {
  return typeof value === "string" && UNIT_ID_SETS[race].has(value);
}

function raceFromLetter(letter: string): Race {
  switch (letter.toUpperCase()) {
    case "P":
      return "Protoss";
    case "T":
      return "Terran";
    case "Z":
      return "Zerg";
    default:
      return "Random";
  }
}
