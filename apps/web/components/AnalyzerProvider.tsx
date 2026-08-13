"use client";

import { useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import {
  DEFAULT_ANALYZER_FILTERS,
  FiltersContext,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import { DEFAULT_PRESET, resolvePreset, type PresetId } from "@/lib/datePresets";
import {
  rollUpSeasons,
  useSeasons,
  type LogicalSeason,
} from "@/lib/useSeasons";
import { useUserSocket } from "@/lib/useUserSocket";
import { AnalysisGamesProvider } from "@/components/analyzer/arcade/hooks/useAnalysisGames";

const LS_KEY = "analyzer.filters";

export type StoredFilters = {
  preset?: PresetId;
  since?: string;
  until?: string;
  regions?: string;
  exclude_too_short?: boolean;
  map_pool?: "ladder" | "nonladder" | "all";
  game_size?: "1v1" | "team" | "all";
};

// Only the globally-visible FilterBar controls persist across reloads.
//
// The drill-down filters (race, opp_race, map, mmr_min, mmr_max, build,
// opp_strategy) are deliberately NOT persisted. They get set by clicking
// into a chart / build / MMR bucket / strategy, but the FilterBar has no
// UI to display or clear them — so persisting them silently hid data
// across sessions: an opponent would vanish from the Opponents tab (which
// then runs the filtered aggregation path) because a stale opp_strategy /
// mmr / build filter from an earlier drill-down stuck in localStorage,
// with no visible indication and no way to reset short of clearing site
// data. They still apply for the active session via the in-memory filter
// state; they just reset on reload instead of becoming an invisible,
// permanent constraint. Stripping on BOTH read and write also self-heals
// any session that already has a stale value persisted.
const PERSISTED_KEYS = [
  "preset",
  "since",
  "until",
  "regions",
  "exclude_too_short",
  "map_pool",
  "game_size",
] as const;

export function pickPersisted(f: Partial<AnalyzerFilters>): StoredFilters {
  const out: Record<string, unknown> = {};
  for (const k of PERSISTED_KEYS) {
    const v = (f as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as StoredFilters;
}

function readStored(): StoredFilters | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return pickPersisted(JSON.parse(raw) as Partial<AnalyzerFilters>);
  } catch {
    return null;
  }
}

function writeStored(value: Partial<AnalyzerFilters>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(pickPersisted(value)));
  } catch {
    /* non-fatal */
  }
}

function initialFilters(): AnalyzerFilters {
  // "Hide too-short games" defaults ON: a brand-new analyzer session
  // automatically excludes the < 30 s no-build-order cohort so the
  // KPI strip / opponent profile / aggregates aren't polluted by
  // disconnects + insta-quits. The user can flip it off via the
  // FilterBar toggle, which writes ``exclude_too_short: false`` to
  // localStorage so their choice persists on subsequent visits.
  const range = resolvePreset(DEFAULT_PRESET);
  return {
    ...DEFAULT_ANALYZER_FILTERS,
    since: range.since?.toISOString(),
    until: range.until?.toISOString(),
  };
}

/**
 * Merge persisted FilterBar state with current product defaults.
 * Missing mode keys identify first-time or legacy storage and inherit
 * ranked-ladder + 1v1. Explicit "all" choices survive verbatim.
 */
export function hydrateStoredFilters(
  stored: StoredFilters | null,
  logicalSeasons: LogicalSeason[] = [],
): AnalyzerFilters {
  const next: AnalyzerFilters = {
    ...DEFAULT_ANALYZER_FILTERS,
    ...(stored || {}),
  };
  if (!next.preset) next.preset = DEFAULT_PRESET;
  if (next.preset !== "custom") {
    const range = resolvePreset(next.preset, undefined, logicalSeasons);
    next.since = range.since ? range.since.toISOString() : undefined;
    next.until = range.until ? range.until.toISOString() : undefined;
  }
  if (next.exclude_too_short === undefined) next.exclude_too_short = true;
  if (next.map_pool === undefined) next.map_pool = "ladder";
  if (next.game_size === undefined) next.game_size = "1v1";
  return next;
}

/**
 * Wraps the analyzer pages with shared filter state + a `dbRev`
 * counter that downstream useApi hooks include in their cache key so
 * they re-fetch when the user clicks Refresh.
 *
 * The chosen date preset is persisted to localStorage so it survives
 * page reloads. New users default to the post-5.0.16 8-worker era. A
 * non-custom preset is re-resolved against "now" (and
 * against the latest SC2Pulse season catalog) on every mount, so a
 * saved "Last 7 days" reflects today's window and "Current season"
 * tracks whichever season is current right now. Fresh and legacy
 * sessions default to ranked-ladder 1v1 unless an explicit persisted
 * mode choice overrides that cohort.
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
    const next = hydrateStoredFilters(stored, logicalSeasons);
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
    <FiltersContext.Provider value={value}>
      <AnalysisGamesProvider>{children}</AnalysisGamesProvider>
    </FiltersContext.Provider>
  );
}
