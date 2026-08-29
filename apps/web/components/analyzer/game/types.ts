/**
 * Client-side types for the per-game deep-dive page (/app/game/[gameId]).
 *
 * `GameSummary` mirrors the slim row GET /v1/games/:gameId returns
 * (apps/api/src/services/games.js — the heavy fields were split into
 * the detail store in v0.4.3, so this row is metadata only). Every
 * field except gameId is optional: older agent uploads simply omit
 * what they didn't extract.
 */

export interface GameOpponentSummary {
  displayName?: string | null;
  race?: string | null;
  mmr?: number | null;
  strategy?: string | null;
  pulseId?: string | null;
}

export interface GameSummary {
  gameId: string;
  /** ISO date-time of the replay's end. */
  date?: string | null;
  /** "Victory" | "Defeat" | "Tie" on slim rows. */
  result?: string | null;
  map?: string | null;
  myRace?: string | null;
  myBuild?: string | null;
  myMmr?: number | null;
  durationSec?: number | null;
  playerCount?: number | null;
  matchFormat?: "1v1" | "team" | "ffa" | "other" | null;
  macroScore?: number | null;
  apm?: number | null;
  spq?: number | null;
  /** Flattened replay fields used by opponent-history projections. */
  replayAvailable?: boolean;
  replayFilename?: string | null;
  replaySizeBytes?: number | null;
  /** Completed R2 marker returned by the direct game-detail endpoint. */
  replayFile?: {
    storedAt?: string | null;
    sizeBytes?: number | null;
  } | null;
  opponent?: GameOpponentSummary | null;
}

/** Raw event shape from GET /v1/games/:id/build-order (perGameCompute). */
export interface GameBuildOrderEvent {
  time: number;
  time_display?: string;
  name: string;
  display?: string;
  race?: string;
  category?: string;
  tier?: number;
  is_building?: boolean;
}

export interface GameBuildOrderResponse {
  ok: boolean;
  game_id: string;
  my_build: string | null;
  my_race: string | null;
  opp_strategy: string | null;
  opponent: string | null;
  opp_race: string | null;
  map: string | null;
  result: string | null;
  events: GameBuildOrderEvent[];
  early_events: GameBuildOrderEvent[];
  opp_events: GameBuildOrderEvent[];
  opp_early_events: GameBuildOrderEvent[];
  my_status?: "ok" | "empty" | "not_extracted";
  opp_status?: "ok" | "empty" | "not_extracted";
}

export function isWinResult(result: string | null | undefined): boolean {
  return result === "Win" || result === "Victory";
}

export function isLossResult(result: string | null | undefined): boolean {
  return result === "Loss" || result === "Defeat";
}
