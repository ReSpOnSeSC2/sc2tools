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

/** Gateway-unit reveal styles. One is chosen after the build reveal. */
export const UNIT_REVEAL_STYLES = [
  "warp-gate",
  "psi-draft",
  "power-surge",
] as const;

export type UnitRevealStyle = (typeof UNIT_REVEAL_STYLES)[number];

/** Protoss Gateway units supported by the opening-unit randomizer. */
export const GATEWAY_UNIT_IDS = [
  "zealot",
  "stalker",
  "sentry",
  "adept",
] as const;

export type GatewayUnitId = (typeof GATEWAY_UNIT_IDS)[number];
export type GatewayCount = 1 | 2;

/** One selected unit and its relative custom weight. */
export interface WeightedGatewayUnit {
  id: GatewayUnitId;
  weight: number;
}

/** Per-build settings for the one- or two-Gateway opening roll. */
export interface OpeningUnitsConfig {
  gateCount: GatewayCount;
  /** Off means every selected unit has equal odds. */
  useCustomWeights: boolean;
  /** Presence in this list means selected. */
  units: WeightedGatewayUnit[];
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
  /** Protoss-only second-stage roll shown after this build wins. */
  openingUnits?: OpeningUnitsConfig;
}

/** Per-matchup randomizer settings. */
export interface MatchupConfig {
  /** Whether the randomizer fires for this matchup. */
  enabled: boolean;
  /** Opt-in: honour `build.weight` instead of equal chance. */
  useCustomWeights: boolean;
  /** Whether the winning build should proceed to its opening-unit roll. */
  unitRandomizerEnabled: boolean;
  builds: RandomizerBuild[];
}

/** Reveal sound-effect settings. */
export interface RandomizerSound {
  enabled: boolean;
  /** 0..1 master volume. */
  volume: number;
}

/** Full randomizer config — one entry per matchup. */
export interface RandomizerConfig {
  version: 2;
  matchups: Record<MatchupKey, MatchupConfig>;
  sound: RandomizerSound;
}

/** Result of the optional opening-unit roll for the chosen build. */
export interface OpeningUnitsOutcome {
  gateCount: GatewayCount;
  /** One pick per Gateway. Picks are independent and may repeat. */
  picks: GatewayUnitId[];
  style: UnitRevealStyle;
  /** Eligible selected units, in display order. */
  pool: WeightedGatewayUnit[];
  /** Normalized landing probabilities, parallel to `pool`. */
  probabilities: number[];
}

/** Result of a single spin. */
export interface SpinOutcome {
  matchup: MatchupKey;
  winner: RandomizerBuild;
  style: RevealStyle;
  /** The pool that was eligible, in display order. */
  pool: RandomizerBuild[];
  /** Normalized landing probabilities, parallel to `pool`. 0..1. */
  probabilities: number[];
  /** Null when the matchup/build is not eligible for the second stage. */
  openingUnits: OpeningUnitsOutcome | null;
}

const MATCHUP_SET = new Set<string>(MATCHUPS);

export function isMatchupKey(value: unknown): value is MatchupKey {
  return typeof value === "string" && MATCHUP_SET.has(value);
}

/** Split a matchup key into its component races. */
export function matchupRaces(m: MatchupKey): { my: Race; vs: Race } {
  return { my: raceFromLetter(m[0]), vs: raceFromLetter(m[2]) };
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
