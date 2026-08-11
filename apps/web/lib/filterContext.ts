"use client";

// Shared filter state for the analyzer SPA. Mirrors the global filter
// bar in the legacy SPA — since/until/race/opp_race/map/mmr_min/mmr_max,
// plus a `preset` id used by the date-range picker so KPI cards can
// label themselves accurately ("Win rate · Season 67").
//
// `seasons` carries the SC2Pulse-backed catalog (rolled up to one
// row per logical season number) so picker labels and KPI cards can
// resolve "current season" without re-fetching the catalog
// independently.

import { createContext, useContext } from "react";
import { DEFAULT_PRESET, type PresetId } from "@/lib/datePresets";
import type { LogicalSeason } from "@/lib/useSeasons";

export type AnalyzerFilters = {
  since?: string;
  until?: string;
  race?: string;
  opp_race?: string;
  map?: string;
  mmr_min?: number;
  mmr_max?: number;
  /** Filter by the user's classified build (myBuild on game records). */
  build?: string;
  /** Filter by the detected opponent strategy (opponent.strategy). */
  opp_strategy?: string;
  /**
   * Drop replays that ended in under 30 seconds (no build order
   * developed) from every analyzer tab's queries. The strategy
   * detector tags these as "<X>v<Y> - Game Too Short" on BOTH
   * `myBuild` and `opponent.strategy`; the API's `gamesMatchStage`
   * applies a negated regex on whichever field isn't already
   * constrained.
   */
  exclude_too_short?: boolean;
  /**
   * Battle.net regions to include. Comma-separated label list (e.g.
   * "NA,EU,KR"). Empty / undefined means "all regions" (the default).
   * Drives a region-bucket filter on every analyzer tab — Opponents,
   * Strategies, Trends, Maps, Builds — so a multi-region streamer
   * can isolate, say, their EU ladder grind from their NA grind in
   * one click. The API derives an opponent's region from
   * ``opponent.region`` (stored at ingest) with a fallback to the
   * toon_handle's leading byte for rows that pre-date the field.
   */
  regions?: string;
  /**
   * Ladder-game filter. "ladder" keeps ranked ladder games;
   * "nonladder" keeps custom / unranked games. The legacy wire name is
   * ``map_pool``, but current replays use the authoritative matchmaking
   * flag. Rows without that flag are excluded from explicit buckets so a
   * custom lobby on a ladder map cannot leak into Ladder. "all" is an
   * explicit, persisted no-constraint choice. Default = "ladder".
   */
  map_pool?: "ladder" | "nonladder" | "all";
  /**
   * Match-format filter. "1v1" keeps one-player-per-side games; "team"
   * keeps actual team formats (2v2 / 3v3 / 4v4) without admitting FFA.
   * Backed by the agent's normalized ``matchFormat``; a legacy
   * ``playerCount: 2`` is a safe 1v1 fallback, while Team stays strict.
   * "all" is an explicit, persisted no-constraint choice. Default = "1v1".
   */
  game_size?: "1v1" | "team" | "all";
  /** Preset id selected in the date filter; not sent to the API. */
  preset?: PresetId;
};

/**
 * Product defaults shared by the context fallback and AnalyzerProvider.
 * A fresh or legacy session starts with ranked-ladder 1v1 games only.
 */
export const DEFAULT_ANALYZER_FILTERS = {
  preset: DEFAULT_PRESET,
  exclude_too_short: true,
  map_pool: "ladder",
  game_size: "1v1",
} as const satisfies AnalyzerFilters;

export type FiltersValue = {
  filters: AnalyzerFilters;
  setFilters: (next: AnalyzerFilters) => void;
  dbRev: number;
  bumpRev: () => void;
  /** SC2Pulse-backed season catalog, rolled up by season number. */
  seasons: LogicalSeason[];
};

export const FiltersContext = createContext<FiltersValue>({
  filters: { ...DEFAULT_ANALYZER_FILTERS },
  setFilters: () => {},
  dbRev: 0,
  bumpRev: () => {},
  seasons: [],
});

export function useFilters(): FiltersValue {
  return useContext(FiltersContext);
}

/** Keys we never send to the API — UI-only state. */
const UI_ONLY_KEYS = new Set(["preset"]);

/** Build a query string from filter object — empty values dropped. */
export function filtersToQuery(p: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === "") continue;
    if (UI_ONLY_KEYS.has(k)) continue;
    // ``exclude_too_short: false`` is the user's explicit opt-out and
    // needs to land in localStorage so the choice persists, but sending
    // it on the wire is a no-op (the API's gamesMatchStage only acts
    // when the flag is truthy). Drop it here so the query string stays
    // clean when the toggle is off.
    if (k === "exclude_too_short" && v === false) continue;
    // Unlike undefined, "all" survives localStorage so a user's explicit
    // opt-out from the default cohort persists. It remains a no-op on the
    // wire, where an omitted parameter means no constraint.
    if ((k === "map_pool" || k === "game_size") && v === "all") continue;
    usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? `?${q}` : "";
}
