"use client";

// Shared filter state for the analyzer SPA. Mirrors the global filter
// bar in the legacy SPA — since/until/race/opp_race/map/mmr_min/mmr_max.

import { createContext, useContext } from "react";

export type AnalyzerFilters = {
  since?: string;
  until?: string;
  race?: string;
  opp_race?: string;
  map?: string;
  mmr_min?: number;
  mmr_max?: number;
};

export type FiltersValue = {
  filters: AnalyzerFilters;
  setFilters: (next: AnalyzerFilters) => void;
  dbRev: number;
  bumpRev: () => void;
};

export const FiltersContext = createContext<FiltersValue>({
  filters: {},
  setFilters: () => {},
  dbRev: 0,
  bumpRev: () => {},
});

export function useFilters(): FiltersValue {
  return useContext(FiltersContext);
}

/** Build a query string from filter object — empty values dropped. */
export function filtersToQuery(p: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? `?${q}` : "";
}
