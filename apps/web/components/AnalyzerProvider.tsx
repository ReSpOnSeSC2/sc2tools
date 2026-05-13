"use client";

import { useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import {
  FiltersContext,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { DEFAULT_PRESET, resolvePreset, type PresetId } from "@/lib/datePresets";
import { rollUpSeasons, useSeasons } from "@/lib/useSeasons";
import { useUserSocket } from "@/lib/useUserSocket";

const LS_KEY = "analyzer.filters";

type StoredFilters = {
  preset?: PresetId;
  since?: string;
  until?: string;
  race?: string;
  opp_race?: string;
  map?: string;
  mmr_min?: number;
  mmr_max?: number;
  build?: string;
  opp_strategy?: string;
};

function readStored(): StoredFilters | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as StoredFilters) : null;
  } catch {
    return null;
  }
}

function writeStored(value: StoredFilters): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(value));
  } catch {
    /* non-fatal */
  }
}

function initialFilters(): AnalyzerFilters {
  return { preset: DEFAULT_PRESET };
}

/**
 * Wraps the analyzer pages with shared filter state + a `dbRev`
 * counter that downstream useApi hooks include in their cache key so
 * they re-fetch when the user clicks Refresh.
 *
 * The chosen date preset is persisted to localStorage so it survives
 * page reloads. A non-custom preset is re-resolved against "now" (and
 * against the latest SC2Pulse season catalog) on every mount, so a
 * saved "Last 7 days" reflects today's window and "Current season"
 * tracks whichever season is current right now.
 */
export function AnalyzerProvider({ children }: { children: ReactNode }) {
  const [filters, setFiltersState] = useState<AnalyzerFilters>(initialFilters);
  const [dbRev, setDbRev] = useState(0);
  const bumpRev = useCallback(() => setDbRev((v) => v + 1), []);

  // Cloud-driven auto-refresh. The games ingest route fans out
  // ``games:changed`` to ``user:<userId>``; bumping ``dbRev`` invalidates
  // every ``useApiPaginated`` cache key downstream, so the Opponents
  // table, KPI strip, charts, etc. re-fetch within a few hundred
  // milliseconds of the agent posting a finished game. The handler
  // object is memoised so the socket effect doesn't reconnect every
  // render.
  const socketHandlers = useMemo(
    () => ({
      "games:changed": () => bumpRev(),
    }),
    [bumpRev],
  );
  useUserSocket(socketHandlers);

  const { data: seasonsData } = useSeasons();
  const logicalSeasons = useMemo(
    () => rollUpSeasons(seasonsData?.items),
    [seasonsData],
  );

  // Hydrate from localStorage after mount.
  useEffect(() => {
    const stored = readStored();
    const next: AnalyzerFilters = stored ? { ...stored } : { preset: DEFAULT_PRESET };
    if (!next.preset) next.preset = DEFAULT_PRESET;
    if (next.preset && next.preset !== "custom") {
      const range = resolvePreset(next.preset, undefined, logicalSeasons);
      next.since = range.since ? range.since.toISOString() : undefined;
      next.until = range.until ? range.until.toISOString() : undefined;
    }
    setFiltersState(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the season catalog finally loads, re-resolve any preset
  // that depends on it (current_season / season:N) so the dates snap
  // from the approximation to SC2Pulse's real boundaries.
  useEffect(() => {
    if (logicalSeasons.length === 0) return;
    setFiltersState((prev) => {
      const id = prev.preset;
      if (!id || id === "custom") return prev;
      if (id !== "current_season" && !id.startsWith("season:")) return prev;
      const range = resolvePreset(id, undefined, logicalSeasons);
      return {
        ...prev,
        since: range.since ? range.since.toISOString() : undefined,
        until: range.until ? range.until.toISOString() : undefined,
      };
    });
  }, [logicalSeasons]);

  const setFilters = useCallback((next: AnalyzerFilters) => {
    setFiltersState(next);
    writeStored(next);
  }, []);

  const value = useMemo(
    () => ({
      filters,
      setFilters,
      dbRev,
      bumpRev,
      seasons: logicalSeasons,
    }),
    [filters, setFilters, dbRev, bumpRev, logicalSeasons],
  );
  return (
    <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>
  );
}
