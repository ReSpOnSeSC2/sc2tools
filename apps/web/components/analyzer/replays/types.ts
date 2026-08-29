import type { GameStreamLink } from "@/components/analyzer/GameStreamLinks";
import type { MacroBreakdownData } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type {
  GameBuildOrderResponse,
  GameSummary,
} from "@/components/analyzer/game/types";

/** Public-safe player identity attached to one replay row. */
export interface ReplayOpponent {
  displayName?: string | null;
  race?: string | null;
  mmr?: number | null;
  strategy?: string | null;
}

/**
 * Compact replay-library row. This intentionally mirrors the API allowlist;
 * storage keys, replay hashes and ladder-account identifiers do not belong on
 * either the signed-in table or its shareable counterpart.
 */
export interface ReplayLibraryItem {
  gameId: string;
  date?: string | null;
  result?: string | null;
  map?: string | null;
  durationSec?: number | null;
  playerCount?: number | null;
  matchFormat?: "1v1" | "team" | "ffa" | "other" | null;
  myRace?: string | null;
  myBuild?: string | null;
  myMmr?: number | null;
  macroScore?: number | null;
  opponent?: ReplayOpponent | null;
  matchup?: string | null;
  streams?: GameStreamLink[];
  /** Archive availability only. Public payloads never include storage keys. */
  replayAvailable?: boolean;
  replayFilename?: string | null;
  replaySizeBytes?: number | null;
}

export interface ReplayLibraryProfile {
  handle: string;
  displayName: string;
}

export interface ReplayLibraryPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ReplayLibraryResponse {
  profile: ReplayLibraryProfile;
  items: ReplayLibraryItem[];
  page: ReplayLibraryPageInfo;
  /** Exact count for the active filters when the data store can supply it. */
  total?: number;
}

export interface ReplaySharingResponse {
  enabled: boolean;
  handle: string | null;
  updatedAt?: string | null;
}

export interface PublicReplayDetailResponse {
  profile: ReplayLibraryProfile;
  game: GameSummary;
  macroBreakdown?: MacroBreakdownData | null;
  buildOrder?: GameBuildOrderResponse | null;
  streams?: GameStreamLink[];
}
