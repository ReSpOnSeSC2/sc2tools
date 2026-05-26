/**
 * Type contracts for the user-builds library (cloud) — the API
 * `/v1/custom-builds` shape plus a few derived UI types.
 *
 * Kept small and focused on the surface the cloud frontend renders.
 * The persisted document on the server permits additional fields
 * (additionalProperties: true) so we can add UI-only annotations
 * without bumping the schema validator.
 */
import type { BuildSignatureItem } from "@/lib/build-events";
import type { Race, VsRace } from "@/lib/race";

export type {
  BuildPhasePayload,
  BuildTransitionsPayload,
} from "@/lib/serverApi";

export type BuildPerspective = "you" | "opponent";

export interface CustomBuild {
  /** Stable client-generated id used as the URL slug. */
  slug: string;
  /** Display name. */
  name: string;
  race: Race;
  vsRace?: VsRace;
  description?: string;
  notes?: string;
  isPublic?: boolean;
  signature?: BuildSignatureItem[];
  /** ISO timestamp of the last write. */
  updatedAt?: string;
  createdAt?: string;
  /** Optional source replay reference when the build was captured from a game. */
  sourceGameId?: string;
  /** "you" if saved from the player's own build, "opponent" if captured from an opponent. */
  perspective?: BuildPerspective;
  /** Race the opponent was playing when the build was captured (only set when perspective="opponent"). */
  opponentRace?: Race;
}

/** Aggregate stats from /v1/builds, keyed by build name (NOT slug). */
export interface BuildStats {
  name: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  lastPlayed?: string | null;
}

/** Decorated build = CustomBuild + optional aggregate stats. */
export interface DecoratedBuild extends CustomBuild {
  stats?: BuildStats;
}

/** Detail response shape from /v1/builds/:name. */
export interface BuildDetailRow {
  name: string;
  wins: number;
  losses: number;
  total: number;
  winRate?: number;
}

export interface BuildRecentGame {
  gameId: string;
  date: string;
  map?: string;
  opponent?: string;
  opp_race?: string;
  opp_strategy?: string | null;
  result: "win" | "loss" | "victory" | "defeat" | string;
  duration?: number;
  macroScore?: number | null;
}

export interface BuildDetailResponse {
  name: string;
  totals: {
    wins: number;
    losses: number;
    total: number;
    winRate: number;
    lastPlayed?: string | null;
  };
  byMatchup: BuildDetailRow[];
  byMap: BuildDetailRow[];
  byStrategy: BuildDetailRow[];
  recent: BuildRecentGame[];
}

/**
 * One rule on an auto-classify discovery candidate. Mirrors the v3
 * rule shape the cloud's buildRulesEvaluator consumes — `count` is
 * only present on the count_* rule types.
 */
export interface AutoCandidateRule {
  type: "before" | "not_before" | "count_max" | "count_exact" | "count_min";
  name: string;
  time_lt: number;
  count?: number;
}

/** Sample game preview attached to each discovery candidate. */
export interface AutoCandidateSampleGame {
  gameId: string;
  map: string | null;
  result: string | null;
  date: string | null;
}

/**
 * Discovery-engine candidate returned by GET /v1/auto-classify/candidates.
 * Mirrors AutoClassifyService.DiscoveryCandidate exactly — the same
 * shape is round-tripped back to POST /v1/auto-classify/apply.
 */
export interface AutoCandidate {
  matchup: string;
  perspective: BuildPerspective;
  proposedName: string;
  proposedSlug: string;
  race: "Protoss" | "Terran" | "Zerg";
  vsRace: "Protoss" | "Terran" | "Zerg";
  rules: AutoCandidateRule[];
  gameCount: number;
  winRate: number;
  cohesion: number;
  selfMatchRate: number;
  sampleGames: AutoCandidateSampleGame[];
}

/** Top-level payload from GET /v1/auto-classify/candidates. */
export interface AutoCandidatesResponse {
  perspective: BuildPerspective;
  candidates: AutoCandidate[];
}

/**
 * Result of POST /v1/auto-classify/apply. `created` lists the slugs of
 * the candidates that were upserted; the remaining fields come straight
 * from CustomBuildsService.reclassifyAll.
 */
export interface AutoApplyResult {
  ok: true;
  created: string[];
  builds: number;
  scanned: number;
  tagged: number;
  cleared: number;
  perBuild: Array<{
    slug: string;
    name: string;
    matched: number;
    tagged: number;
  }>;
}
