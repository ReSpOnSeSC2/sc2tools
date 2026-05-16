// Arcade type contracts. Every mode implements Mode<Q, A, S> — the
// engine drives them through generate → render → score without ever
// reaching into mode internals.

import type { ReactNode } from "react";

/**
 * Depth tag — the single-source-of-truth value asserting why this mode
 * isn't visible by sorting one column on an existing analyzer tab.
 * The CI depth-lint refuses unset/unknown values.
 */
export const DEPTH_TAGS = [
  "multi-entity",
  "cross-axis",
  "temporal",
  "conditional",
  "hidden-derivation",
  "forward",
  "generative",
] as const;

export type DepthTag = (typeof DEPTH_TAGS)[number];

export type ModeKind = "quiz" | "game";

export type ModeCategory =
  | "matchups"
  | "streaks"
  | "sessions"
  | "builds"
  | "macro"
  | "forecast"
  | "collection";

export type ModeDifficulty = "easy" | "medium" | "hard";

/**
 * Time-to-play classification. Used by Quick Play to filter ("under 60s",
 * "5 minutes", "any"); not enforced as a hard cap on the mode itself.
 */
export type ModeTtp = "fast" | "medium" | "long";

/**
 * Result of generate() — either a payload the mode renders against, or
 * null when the user's data is below the mode's gate (we render the
 * empty state instead, never synthesise).
 */
export type GenerateResult<Q> =
  | { ok: true; question: Q; minDataMet: true }
  | { ok: false; reason: string; cta?: { label: string; href: string } };

/** Score result — kind enums let the engine award XP / badges generically. */
export interface ScoreResult {
  /** Raw correctness score [0,1]. 1 = perfect. */
  raw: number;
  /** XP awarded. */
  xp: number;
  /** "correct" | "partial" | "wrong" — drives the reveal animation. */
  outcome: "correct" | "partial" | "wrong";
  /** Optional per-mode notes shown in the reveal (e.g. "off by one"). */
  note?: string;
}

/**
 * Share summary — the plain-text version of a round, used by the
 * canvas-rendered share card. Each mode declares (1) the question
 * prompt the user just answered and (2) the multi-line review
 * (correct answer + breakdown / detail rows). The share card stacks
 * these into a "Question / Answer" layout so the recipient can see
 * the same context the in-app reveal showed, not just the mode title.
 */
export interface ShareSummary {
  /** The question prompt as plain text (single short paragraph). */
  question: string;
  /** Review lines — correct answer + supporting breakdown. */
  answer: string[];
}

/** Common props every render() receives. */
export interface RenderContext<Q, A, S> {
  question: Q;
  /** When user has answered, this is set; otherwise null. */
  answer: A | null;
  onAnswer: (answer: A) => void;
  /** Score is set after the engine scores the answer. */
  score: S | null;
  /** Whether the result reveal is showing (post-answer). */
  revealed: boolean;
  /** Daily-mode flag — affects "share" affordance and seed UI. */
  isDaily: boolean;
}

/**
 * Mode — one self-contained quiz or game. Engine instantiates these
 * once per session via dynamic import; generate() and score() are pure
 * functions over an injected DataAccess.
 */
export interface Mode<Q, A, S extends ScoreResult = ScoreResult> {
  id: string;
  kind: ModeKind;
  category: ModeCategory;
  difficulty: ModeDifficulty;
  /** Time-to-play classification — purely for QuickPlay filtering. */
  ttp: ModeTtp;
  /** Required: the depth tag asserting why this isn't a single column sort. */
  depthTag: DepthTag;
  /** Short label shown in pickers. */
  title: string;
  /** One-line description shown in QuickPlay cards. */
  blurb: string;
  /**
   * Pure generator. Takes data accessors + a seeded RNG and returns the
   * round's question, or a non-ok result with the empty-state reason.
   */
  generate: (input: GenerateInput) => Promise<GenerateResult<Q>>;
  /** Render the question + capture the answer. */
  render: (ctx: RenderContext<Q, A, S>) => ReactNode;
  /** Pure scoring function. */
  score: (question: Q, answer: A) => S;
  /**
   * Optional: build a plain-text share summary (question + review)
   * after the user has answered. When omitted, ModeRunner falls back
   * to `mode.blurb` + `score.note` so every mode at least surfaces
   * the question framing along with the one-line outcome.
   */
  share?: (question: Q, answer: A | null, score: S) => ShareSummary;
}

/** Data accessors injected into generate(). All read-only, real data only. */
export interface GenerateInput {
  /** Seeded RNG for daily / shareable rounds. */
  rng: () => number;
  /** Daily seed string ("YYYY-MM-DD"); empty for Quick Play. */
  daySeed: string;
  /** User's IANA timezone (used for session/week math). */
  tz: string;
  data: ArcadeDataset;
}

/**
 * The dataset bundle handed to every generate(). Hooks build this once
 * per arcade session and reuse across modes — no mode is allowed to
 * fetch data itself; all I/O routes through useArcadeData.
 */
export interface ArcadeDataset {
  games: ArcadeGame[];
  opponents: ArcadeOpponent[];
  builds: ArcadeBuild[];
  customBuilds: ArcadeCustomBuild[];
  communityBuilds: ArcadeCommunityBuild[];
  // /v1/matchups rows. The API returns ``{ name: "vs P" | "vs T" | "vs Z"
  // | "vs Unknown" }`` (see apps/api/src/services/aggregations.js
  // ``matchupFacet``) — ``oppRace`` is the parsed race letter that
  // useArcadeData lifts off ``name`` so quiz modes don't have to know
  // about the wire format.
  matchups: Array<{
    name: string;
    oppRace: "P" | "T" | "Z" | null;
    wins: number;
    losses: number;
    total: number;
    winRate: number;
  }>;
  maps: Array<{ map: string; wins: number; losses: number; total: number; winRate: number }>;
  summary: ArcadeSummary | null;
  mapPool: string[];
  /**
   * Per-unit aggregate over the user's recent games (server-bounded
   * to the most recent ~1000). Populated lazily by useArcadeData via
   * /v1/arcade/unit-stats; null while the request is still in flight
   * or if the call fails. Trivia modes that need this gate on the
   * field being non-null and on ``scannedGames`` being above their
   * own minimum (typically 25 games).
   *
   * Optional on the type so fixtures in other quiz tests (which don't
   * exercise the trivia) don't have to be touched — readers always
   * coalesce to null when absent.
   */
  unitStats?: ArcadeUnitStats | null;
}

export interface ArcadeUnitStats {
  /** How many games the server scanned to compute this aggregate. */
  scannedGames: number;
  /** Map: SC2 unit name → number of buildLog entries across scanned games. */
  builtByUnit: Record<string, number>;
  /** Σ of macroBreakdown.player_stats.me.units_lost across scanned games. */
  totalUnitsLost: number;
  /** Number of scanned games that contributed a units_lost figure. */
  lostGames: number;
}

export interface ArcadeGame {
  gameId: string;
  date: string;
  result: string;
  myRace?: string;
  oppRace?: string;
  myMmr?: number;
  oppMmr?: number;
  duration?: number;
  map?: string;
  myBuild?: string | null;
  opp_strategy?: string | null;
  oppPulseId?: string;
  opponent?: { displayName?: string; mmr?: number; race?: string };
  macro_score?: number | null;
}

export interface ArcadeOpponent {
  /** Stable id used as the React key and in question payloads. */
  pulseId: string;
  /** Canonical numeric sc2pulse character id, when resolved at ingest. */
  pulseCharacterId?: string | null;
  /** Raw display name from the source row (may be a smurf barcode). */
  name: string;
  /** Resolved sc2pulse display name; preferred over `name` when present. */
  displayName?: string | null;
  wins: number;
  losses: number;
  games: number;
  /**
   * The USER's win rate against this opponent (wins / (wins+losses)).
   * "userWinRate" — disambiguated from the opponent's perspective.
   * Modes phrased as "WR vs you" must rank by opponentWinRate (below),
   * not this field.
   */
  userWinRate: number;
  /**
   * The OPPONENT's win rate against the user. Always 1 - userWinRate
   * when total > 0, 0 otherwise. Pre-computed so modes that prompt
   * "WR against you" don't have to remember to invert.
   */
  opponentWinRate: number;
  lastPlayed: string | null;
}

export interface ArcadeBuild {
  name: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  race?: string;
  lastPlayed?: string | null;
}

export interface ArcadeCustomBuild {
  slug: string;
  name: string;
  race: string;
  vsRace?: string;
}

export interface ArcadeCommunityBuild {
  slug: string;
  title: string;
  race?: string;
  matchup?: string;
  votes: number;
}

export interface ArcadeSummary {
  totalGames: number;
  wins: number;
  losses: number;
  winRate: number;
}

/* ──────────────── Persisted state ──────────────── */

/**
 * The blob persisted to /v1/me/preferences/arcade. Always read+write
 * the whole thing — schemaVersion lets us migrate later.
 */
export interface ArcadeState {
  schemaVersion: 1;
  streak: { count: number; lastPlayedDay: string | null };
  xp: { total: number; level: number };
  minerals: number;
  /** Set of unlocked card slugs (build name → unlock timestamp). */
  unlockedCards: Record<string, { unlockedAt: string }>;
  /** Earned badge ids → first-earned timestamp. */
  badges: Record<string, { earnedAt: string }>;
  /** Per-mode personal-best stats. */
  records: Record<string, ModeRecord>;
  /** Stock Market state. Null when no portfolio is locked yet. */
  stockMarket: StockMarketState | null;
  /** Active Bingo card. Resets every Monday 00:00 local. */
  bingo: BingoState | null;
  /** Buildle daily progress map: "YYYY-MM-DD" → guesses[]. */
  buildleByDay: Record<string, BuildleProgress>;
  /** Cosmetic preferences (mascot skin, card-back theme). */
  cosmetics: { mascotSkin: string; cardBackTheme: string };
  /** Opt-in flag for the Stock Market leaderboard. */
  leaderboardOptIn: boolean;
  /** Public display name (when opted-in); else used as anonymous. */
  leaderboardDisplayName: string;
}

export interface ModeRecord {
  bestRaw: number;
  bestXp: number;
  attempts: number;
  correct: number;
  lastPlayedAt: string;
  /** For games: best run length / best chain etc. */
  bestRun?: number;
}

export interface StockMarketState {
  weekKey: string; // "YYYY-Www"
  lockedAt: string;
  picks: Array<{
    slug: string;
    alloc: number;
    entryPrice: number;
    /**
     * Total plays for this build at the moment the portfolio locked.
     * Drives the volatility multiplier on P&L: a brand-new build
     * (plays ≤ 7) gets the max amplification (2.0×), a heavily-played
     * build (plays ≥ 53) gets the min damping (0.75×). Captured at
     * lock time so the multiplier is deterministic for the week even
     * if the user plays the build heavily during the window.
     *
     * Optional for back-compat: portfolios locked before the volatility
     * model existed have no `entryPlays` and are treated as vol = 1.0
     * (neutral) on reveal.
     */
    entryPlays?: number;
  }>;
  /** When the user already submitted P&L to the leaderboard for this week. */
  submittedPnl?: number;
}

export interface BingoState {
  startedAt: string;
  weekKey: string;
  rerolled: boolean;
  cells: BingoCell[];
}

export interface BingoCell {
  id: string;
  predicate: string;
  params: Record<string, unknown>;
  label: string;
  ticked: boolean;
  tickedAt?: string;
  gameId?: string;
}

/**
 * Buildle daily progress.
 *
 * The day's mystery is a single real game from the user's history. One
 * fact about that game is hidden; the user picks from 2–4 plausible
 * buckets, all correct-or-wrong (no partial credit). Each entry is a
 * sealed record of which option was offered, which was picked, and
 * whether it matched — locked once for the day.
 */
export interface BuildleProgress {
  /** The gameId of the case file we asked about. */
  gameId: string;
  /** Rotation slot for the day (see BuildleQuestionType in buildle.tsx). */
  questionType: string;
  /** Buttons shown to the user, in the order they were rendered. */
  options: string[];
  /** Index in `options` of the correct answer. */
  correctIndex: number;
  /**
   * Index in `options` the user picked. -1 (or undefined on legacy
   * rows) means the user hasn't answered yet today.
   */
  pickedIndex: number;
  /** Whether the pick matched the correct answer. */
  correct: boolean;
}

export const ARCADE_STATE_DEFAULT: ArcadeState = Object.freeze({
  schemaVersion: 1,
  streak: { count: 0, lastPlayedDay: null },
  xp: { total: 0, level: 1 },
  minerals: 0,
  unlockedCards: {},
  badges: {},
  records: {},
  stockMarket: null,
  bingo: null,
  buildleByDay: {},
  cosmetics: { mascotSkin: "default", cardBackTheme: "default" },
  leaderboardOptIn: true,
  leaderboardDisplayName: "",
}) as ArcadeState;
