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
  /** Preset id selected in the date filter; not sent to the API. */
  preset?: PresetId;
};

export type FiltersValue = {
  filters: AnalyzerFilters;
  setFilters: (next: AnalyzerFilters) => void;
  dbRev: number;
  bumpRev: () => void;
  /** SC2Pulse-backed season catalog, rolled up by season number. */
  seasons: LogicalSeason[];
};

export const FiltersContext = createContext<FiltersValue>({
  filters: { preset: DEFAULT_PRESET },
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
    usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? `?${q}` : "";
}
