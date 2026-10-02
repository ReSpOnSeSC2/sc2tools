"use client";

import { useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import {
  ANALYZER_REGIONS,
  DEFAULT_ANALYZER_FILTERS,
  FiltersContext,
  PTR_REGION,
  normalizeGameLengthBounds,
  type AnalyzerFilters,
} from "@/lib/filterContext";
import {
  DEFAULT_PRESET,
  normalizePresetId,
  resolvePreset,
  type PresetId,
} from "@/lib/datePresets";
import {
  rollUpSeasons,
  useSeasons,
  type LogicalSeason,
} from "@/lib/useSeasons";
import { useUserSocket } from "@/lib/useUserSocket";
import { AnalysisGamesProvider } from "@/components/analyzer/arcade/hooks/useAnalysisGames";

const LS_KEY = "analyzer.filters";

/**
 * Revision of the stored region selection. Selections saved before
 * revision 1 were made when PTR (the Public Test Realm) had no pill, so
 * none of them meant to hide PTR games: `hydrateStoredFilters` adds PTR to
 * them on every load until the next write. Every write stamps the current
 * revision, so a user who then turns PTR off keeps that choice.
 */
export const REGIONS_REV = 1;

export type StoredFilters = {
  preset?: PresetId;
  since?: string;
  until?: string;
  regions?: string;
  /** `REGIONS_REV` when written; storage-only, never part of the filters. */
  regions_rev?: number;
  exclude_too_short?: boolean;
  map_pool?: "ladder" | "nonladder" | "all";
  game_size?: "1v1" | "team" | "all";
  min_minutes?: number;
  max_minutes?: number;
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
  "regions_rev",
  "exclude_too_short",
  "map_pool",
  "game_size",
  "min_minutes",
  "max_minutes",
] as const;

export function pickPersisted(
  f: Partial<AnalyzerFilters> & Pick<StoredFilters, "regions_rev">,
): StoredFilters {
  const out: Record<string, unknown> = {};
  for (const k of PERSISTED_KEYS) {
    const v = (f as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as StoredFilters;
}

/**
 * The blob this build writes: the persisted controls, stamped with the
 * current `REGIONS_REV` (the region selection was made with every pill on
 * offer).
 *
 * Example: `toStoredFilters({ regions: "NA,EU" })` →
 * `{ regions: "NA,EU", regions_rev: 1 }`.
 */
export function toStoredFilters(f: Partial<AnalyzerFilters>): StoredFilters {
  return { ...pickPersisted(f), regions_rev: REGIONS_REV };
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
    window.localStorage.setItem(LS_KEY, JSON.stringify(toStoredFilters(value)));
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

/** True when a stored blob was written at the current `REGIONS_REV` or later. */
function isCurrentRegionsRev(regionsRev: unknown): boolean {
  return typeof regionsRev === "number" && regionsRev >= REGIONS_REV;
}

/**
 * A stored region selection brought up to `REGIONS_REV`. One saved before
 * the PTR pill existed gains PTR, since it could not have meant to hide PTR
 * games; if that leaves every region on, it becomes "no filter", as the
 * FilterBar writes it. A current selection is left exactly as chosen.
 *
 * Example: `migrateStoredRegions("NA,EU", undefined)` → "NA,EU,PTR";
 * `migrateStoredRegions("NA,EU", 1)` → "NA,EU".
 */
export function migrateStoredRegions(
  regions: unknown,
  regionsRev: unknown,
): string | undefined {
  if (typeof regions !== "string" || !regions.trim()) return undefined;
  if (isCurrentRegionsRev(regionsRev)) return regions;
  const tokens = regions.split(",").map((t) => t.trim().toUpperCase());
  const picked = new Set<string>(
    ANALYZER_REGIONS.filter((r) => tokens.includes(r)),
  );
  // No known region: the FilterBar already showed (and the API applied)
  // every region, so there is nothing to keep.
  if (picked.size === 0) return undefined;
  picked.add(PTR_REGION);
  if (picked.size === ANALYZER_REGIONS.length) return undefined;
  return ANALYZER_REGIONS.filter((r) => picked.has(r)).join(",");
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
  // The region revision is storage bookkeeping, not a filter: it stays out
  // of the in-memory filters (and so out of every API query).
  const { regions_rev: regionsRev, ...storedFilters } = stored || {};
  const next: AnalyzerFilters = {
    ...DEFAULT_ANALYZER_FILTERS,
    ...storedFilters,
  };
  // A legacy id ("after_5_0_16", the old live patch) moves to its
  // replacement; a missing or unknown one falls back to the default.
  next.preset = normalizePresetId(next.preset);
  // A selection saved before PTR could be picked gains PTR.
  next.regions = migrateStoredRegions(next.regions, regionsRev);
  if (next.preset !== "custom") {
    const range = resolvePreset(next.preset, undefined, logicalSeasons);
    next.since = range.since ? range.since.toISOString() : undefined;
    next.until = range.until ? range.until.toISOString() : undefined;
  }
  if (next.exclude_too_short === undefined) next.exclude_too_short = true;
  if (next.map_pool === undefined) next.map_pool = "ladder";
  if (next.game_size === undefined) next.game_size = "1v1";
  // localStorage is user-writable and outlives any given build, so the
  // game-length bounds are re-sanitised on the way in rather than
  // trusted. Both default to absent — "any length" — which keeps a
  // first-time session's query string byte-identical to what it was
  // before this filter existed.
  const length = normalizeGameLengthBounds(next.min_minutes, next.max_minutes);
  next.min_minutes = length.min_minutes;
  next.max_minutes = length.max_minutes;
  return next;
}

/**
 * Wraps the analyzer pages with shared filter state + a `dbRev`
 * counter that downstream useApi hooks include in their cache key so
 * they re-fetch when the user clicks Refresh.
 *
 * The chosen date preset is persisted to localStorage so it survives
 * page reloads. New users default to the live 12-worker patch (5.0.17
 * on). A non-custom preset is re-resolved against "now" (and
 * against the latest SC2Pulse season catalog) on every mount, so a
 * saved "Last 7 days" reflects today's window and "Current season"
 * tracks whichever season is current right now. Fresh and legacy
 * sessions default to ranked-ladder 1v1 unless an explicit persisted
 * mode choice overrides that cohort.
 */
export function AnalyzerProvider({
  children,
  analysisGamesEnabled = false,
}: {
  children: ReactNode;
  /** Full replay history is opt-in: Arcade enables it; Daily Pulse can request it. */
  analysisGamesEnabled?: boolean;
}) {
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
      <AnalysisGamesProvider enabled={analysisGamesEnabled}>
        {children}
      </AnalysisGamesProvider>
    </FiltersContext.Provider>
  );
}
