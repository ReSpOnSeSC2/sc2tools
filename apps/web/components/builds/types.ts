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
import type { ReferenceBuildOrder } from "@/lib/buildOrderReference";
import type { BuildRule, SkillLevelId } from "@/lib/build-rules";
import type { Race, VsRace } from "@/lib/race";

export type {
  BuildPhasePayload,
  BuildTransitionsPayload,
} from "@/lib/serverApi";

export type BuildPerspective = "you" | "opponent";

export interface CustomBuild {
  buildOrder?: ReferenceBuildOrder;
  /** Stable client-generated id used as the URL slug. */
  slug: string;
  /** Display name. */
  name: string;
  race: Race;
  vsRace?: VsRace;
  description?: string;
  notes?: string;
  skillLevel?: SkillLevelId | null;
  winConditions?: string[];
  losesTo?: string[];
  transitionsInto?: string[];
  isPublic?: boolean;
  /** Owner-only name mirrored from the Community publication. */
  communityAuthorName?: string;
  /** Anonymous publication is an explicit opt-in. */
  publishAnonymously?: boolean;
  signature?: BuildSignatureItem[];
  /** Advanced v3 match rules authored by the rich custom-build editor. */
  rules?: BuildRule[];
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
  /** Present on provenance-keyed custom-build stats; absent on legacy name buckets. */
  slug?: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  lastPlayed?: string | null;
  /** Games counted here only because of a confirmed build check-in. */
  checkins?: number;
}

/** Decorated build = CustomBuild + optional aggregate stats. */
export interface DecoratedBuild extends CustomBuild {
  stats?: BuildStats;
  /** Distinguishes a verified zero from a failed or unfinished stats request. */
  statsState?: "ready" | "loading" | "unavailable";
  /** Stable-slug classification is preferred; legacy name tags are fallback-only. */
  statsSource?: "classified" | "stored-tags";
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
  /** True when this replay was produced by resuming a prior replay. */
  isResumedFromReplay?: boolean;
  /**
   * Set when a confirmed build check-in put this game on the build: what
   * the replay itself was classified as, and the player's check-in notes.
   */
  planned?: { detected: string | null; notes: string } | null;
}

export interface BuildDetailResponse {
  name: string;
  totals: {
    wins: number;
    losses: number;
    total: number;
    winRate: number;
    lastPlayed?: string | null;
    /** Games counted here only because of a confirmed build check-in. */
    checkins?: number;
  };
  byMatchup: BuildDetailRow[];
  byMap: BuildDetailRow[];
  byStrategy: BuildDetailRow[];
  recent: BuildRecentGame[];
  resumedRecent: BuildRecentGame[];
  resumedCount: number;
}
