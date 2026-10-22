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
import {
  DEFAULT_PRESET,
  longLabelFor,
  patchEraFor,
  resolvePreset,
  type PresetId,
} from "@/lib/datePresets";
import { coerceRace } from "@/lib/race";
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
   * Drop replays that ended in under 45 seconds (no build order
   * developed) from every analyzer tab's queries. The strategy
   * detector tags these as "<X>v<Y> - Game Too Short" on BOTH
   * `myBuild` and `opponent.strategy`; the API's `gamesMatchStage`
   * applies a negated regex on whichever field isn't already
   * constrained.
   */
  exclude_too_short?: boolean;
  /**
   * Battle.net regions to include. Comma-separated label list (e.g.
   * "NA,EU,KR") drawn from `ANALYZER_REGIONS`, PTR (the Public Test
   * Realm) included. Empty / undefined means "all regions" (the default).
   * Drives a region-bucket filter on every analyzer tab — Opponents,
   * Strategies, Trends, Maps, Builds — so a multi-region streamer
   * can isolate, say, their EU ladder grind from their NA grind in
   * one click. The API derives an opponent's region from
   * ``opponent.region`` (stored at ingest) with a fallback to the
   * toon_handle's region prefix ("1-" NA … "98-" PTR) for rows that
   * pre-date the field.
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
  /**
   * Game-length filter, in whole minutes. `min_minutes` is inclusive,
   * `max_minutes` EXCLUSIVE, so adjacent bands ("6–10", "10–14") tile
   * without a game that ended at exactly 10:00 landing in both.
   *
   * The API applies these against `durationSec` — the same field the
   * Macro Report's game-length segments bucket on, which holds real
   * elapsed seconds rather than the ~1.4× "Faster" game clock. Picking
   * "10–14 min" here therefore selects the games behind the Macro tab's
   * "10–14 min" bar, not a differently-scaled cohort.
   *
   * Both are undefined by default ("any length"). This is separate from
   * and additional to `exclude_too_short`, which drops the
   * no-build-order cohort by its "Game Too Short" strategy label rather
   * than by duration — that toggle is deliberately left untouched here,
   * and the two compose (hiding too-short games AND asking for 20+ min).
   */
  min_minutes?: number;
  max_minutes?: number;
  /**
   * Preset id selected in the date filter. Not sent to the API itself; a
   * patch preset adds its `patch_era` (see `filtersToQuery`).
   */
  preset?: PresetId;
};

/** Label of the Public Test Realm (toon handles starting "98-"). */
export const PTR_REGION = "PTR";

/**
 * Every region the `regions` filter can pick, in pill order: the five
 * Battle.net ladder regions plus the PTR, whose games are uploaded like
 * any other and would otherwise sit behind every region selection.
 * Mirrors REGION_LABELS in apps/api/src/util/regionFromToonHandle.js.
 */
export const ANALYZER_REGIONS = ["NA", "EU", "KR", "CN", "SEA", PTR_REGION] as const;

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

/**
 * The complete default filter state: the product defaults with the
 * default date preset resolved to its range. "Reset to defaults" applies
 * exactly this, so every drill-down key (build, opponent strategy, race,
 * map, MMR) goes too.
 *
 * Example: `defaultAnalyzerFilters()` →
 * `{ preset: "after_5_0_17", since: "<5.0.17 release>", exclude_too_short: true, map_pool: "ladder", game_size: "1v1" }`.
 */
export function defaultAnalyzerFilters(seasons?: LogicalSeason[]): AnalyzerFilters {
  const range = resolvePreset(DEFAULT_PRESET, undefined, seasons);
  const out: AnalyzerFilters = { ...DEFAULT_ANALYZER_FILTERS };
  if (range.since) out.since = range.since.toISOString();
  if (range.until) out.until = range.until.toISOString();
  return out;
}

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

/**
 * Longest game length the filter accepts, in minutes. Mirrors the API's
 * `MAX_GAME_LENGTH_MINUTES`; ten hours is far past any real SC2 game, so
 * the cap only ever catches a typo or a hand-edited value.
 */
export const MAX_GAME_LENGTH_MINUTES = 600;

/**
 * Sanitise a pair of game-length bounds.
 *
 * Applied on every path a value can enter from — the picker, and rehydration
 * from localStorage, which is user-writable and can hold anything a previous
 * build (or a console poke) left behind. Non-numeric, negative and zero
 * bounds collapse to "no constraint"; a transposed pair is swapped, matching
 * the API, because reading it literally selects nothing and answering an
 * obvious typo with a blank dashboard is worse than answering with the range
 * that was plainly meant.
 */
export function normalizeGameLengthBounds(
  rawMin: unknown,
  rawMax: unknown,
): { min_minutes?: number; max_minutes?: number } {
  let min = coerceMinutes(rawMin);
  let max = coerceMinutes(rawMax);
  if (min !== undefined && max !== undefined && min > max) {
    [min, max] = [max, min];
  }
  const out: { min_minutes?: number; max_minutes?: number } = {};
  if (min !== undefined) out.min_minutes = min;
  if (max !== undefined) out.max_minutes = max;
  return out;
}

function coerceMinutes(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_GAME_LENGTH_MINUTES);
}

/**
 * Keys we never send to the API — UI-only state. `regions_rev` is the
 * stored region selection's revision (AnalyzerProvider); hydration keeps it
 * out of the filters, and this keeps it off the wire regardless.
 */
const UI_ONLY_KEYS = new Set(["preset", "regions_rev"]);

/**
 * Build a query string from filter object — empty values dropped. A patch
 * preset ("After 5.0.17", "5.0.16", "Before 5.0.16") also sends
 * `patch_era`, so the API keeps games by their own version and not only
 * their date.
 */
export function filtersToQuery(p: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  const patchEra = patchEraFor(p.preset as PresetId | undefined);
  if (patchEra && p.patch_era === undefined) usp.set("patch_era", patchEra);
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

/* ------------------------------------------------------------------
 * Active filters: what is narrowing (or widening) the analyzer right
 * now, in words, and how to undo each piece.
 * ------------------------------------------------------------------ */

/**
 * Plain names for the filter keys, shared by every place that lists the
 * active filters (the chip row under the filter bar, the build
 * composition explorer's scope note). Keys are the query parameters
 * `filtersToQuery` emits, plus `preset`, `mmr` and `length`, which name
 * a whole facet whose value is spread over more than one key.
 */
export const FILTER_LABELS: Readonly<Record<string, string>> = {
  preset: "Date range",
  since: "From",
  until: "Until",
  race: "Your race",
  opp_race: "Opponent race",
  map: "Map",
  mmr: "MMR",
  mmr_min: "Minimum MMR",
  mmr_max: "Maximum MMR",
  opp_strategy: "Opponent strategy",
  build: "Your build",
  length: "Length",
  min_minutes: "Minimum minutes",
  max_minutes: "Maximum minutes",
  macro_min: "Minimum macro",
  macro_max: "Maximum macro",
  regions: "Regions",
  map_pool: "Maps",
  game_size: "Players",
  exclude_too_short: "Too-short games",
  leak: "Leak filter",
};

/** One letter per race the race filters accept. */
export type RaceCode = "P" | "T" | "Z" | "R";

/**
 * A race filter value reduced to its letter, or undefined for "any race"
 * and for anything unrecognisable (a hand-edited localStorage value).
 *
 * Example: `normalizeRaceCode("zerg")` → "Z"; `normalizeRaceCode("x")` → undefined.
 */
export function normalizeRaceCode(raw: unknown): RaceCode | undefined {
  if (typeof raw !== "string") return undefined;
  const letter = raw.trim().charAt(0).toUpperCase();
  return letter === "P" || letter === "T" || letter === "Z" || letter === "R"
    ? letter
    : undefined;
}

/**
 * The regions a `regions` value keeps, in pill order. Empty, missing or
 * unrecognisable input means every region (the default).
 *
 * Example: `activeRegionCodes("eu, na")` → ["NA", "EU"].
 */
export function activeRegionCodes(raw: string | undefined): string[] {
  const tokens = (raw || "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const picked = ANALYZER_REGIONS.filter((r) => tokens.includes(r));
  return picked.length > 0 ? picked : [...ANALYZER_REGIONS];
}

/** Readable game-length range, e.g. "10–20 min", "20+ min", "< 10 min". */
export function gameLengthLabel(min?: number, max?: number): string | null {
  if (min !== undefined && max !== undefined) return `${min}–${max} min`;
  if (min !== undefined) return `${min}+ min`;
  if (max !== undefined) return `< ${max} min`;
  return null;
}

/**
 * Merge a patch into the filters, dropping keys the patch sets to
 * undefined so a cleared filter leaves no trace in the object (or in
 * storage, or in the query string).
 */
export function applyFilterPatch(
  filters: AnalyzerFilters,
  patch: Partial<AnalyzerFilters>,
): AnalyzerFilters {
  const next: Record<string, unknown> = { ...filters, ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next as AnalyzerFilters;
}

/**
 * The filters with the opponent race set (a letter) or cleared
 * (undefined). This is the one setter for the global matchup: the
 * Matchup picker uses it, and so should anything else that offers a
 * "vs Zerg" shortcut. Picking a different race also drops an opponent
 * strategy chosen for the old one, which could no longer match a game.
 */
export function withOppRace(
  filters: AnalyzerFilters,
  oppRace: string | undefined,
): AnalyzerFilters {
  const next = normalizeRaceCode(oppRace);
  if (next === normalizeRaceCode(filters.opp_race)) return filters;
  const dropStrategy = next !== undefined && filters.opp_strategy !== undefined;
  return applyFilterPatch(filters, {
    opp_race: next,
    ...(dropStrategy ? { opp_strategy: undefined } : {}),
  });
}

/**
 * The filters with your own race set or cleared. Picking a different
 * race also drops a build chosen for the old one.
 */
export function withMyRace(
  filters: AnalyzerFilters,
  race: string | undefined,
): AnalyzerFilters {
  const next = normalizeRaceCode(race);
  if (next === normalizeRaceCode(filters.race)) return filters;
  const dropBuild = next !== undefined && filters.build !== undefined;
  return applyFilterPatch(filters, {
    race: next,
    ...(dropBuild ? { build: undefined } : {}),
  });
}

/** Facets the chip row can show, in display order. */
export type ActiveFilterKey =
  | "preset"
  | "regions"
  | "map_pool"
  | "game_size"
  | "length"
  | "exclude_too_short"
  | "race"
  | "opp_race"
  | "build"
  | "opp_strategy"
  | "map"
  | "mmr";

export type ActiveFilter = {
  /** Stable id for the facet; MMR and length each cover two keys. */
  key: ActiveFilterKey;
  /** Facet name from FILTER_LABELS, e.g. "Opponent race". */
  label: string;
  /** The current value in words, e.g. "Zerg" or "10–20 min". */
  value: string;
  /** Merge with `applyFilterPatch` to put just this facet back to its default. */
  clearPatch: Partial<AnalyzerFilters>;
  /** The section where this filter is picked, when the filter bar has no control for it. */
  setIn?: "Strategies";
};

/**
 * Every facet that differs from the defaults, in the order the chip row
 * shows them. An empty list means the analyzer shows the default cohort
 * (12-worker patch, ranked ladder 1v1, too-short games hidden, every
 * region, any length, no drill-down).
 *
 * The same list feeds the chip row, the "Filters · N active" count on
 * phones and the "Games in range" card, and is shaped for the filtered
 * empty state and export scope lines to reuse.
 *
 * Example: `describeActiveFilters({ ...DEFAULT_ANALYZER_FILTERS, opp_race: "Z" })` →
 * `[{ key: "opp_race", label: "Opponent race", value: "Zerg", clearPatch: { opp_race: undefined } }]`.
 */
export function describeActiveFilters(
  filters: AnalyzerFilters,
  options: { seasons?: LogicalSeason[] } = {},
): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const add = (
    key: ActiveFilterKey,
    value: string,
    clearPatch: Partial<AnalyzerFilters>,
    setIn?: ActiveFilter["setIn"],
  ) => {
    out.push({ key, label: FILTER_LABELS[key], value, clearPatch, ...(setIn ? { setIn } : {}) });
  };

  const preset = filters.preset || "all";
  if (preset !== DEFAULT_PRESET) {
    const defaults = defaultAnalyzerFilters(options.seasons);
    add("preset", presetValue(preset, filters, options.seasons), {
      preset: DEFAULT_PRESET,
      since: defaults.since,
      until: defaults.until,
    });
  }

  if ((filters.regions || "").trim()) {
    const regions = activeRegionCodes(filters.regions);
    if (regions.length < ANALYZER_REGIONS.length) {
      add("regions", regions.join(", "), { regions: undefined });
    }
  }

  if (filters.map_pool === "nonladder" || filters.map_pool === "all") {
    add("map_pool", filters.map_pool === "all" ? "All" : "Custom", {
      map_pool: DEFAULT_ANALYZER_FILTERS.map_pool,
    });
  }

  if (filters.game_size === "team" || filters.game_size === "all") {
    add("game_size", filters.game_size === "all" ? "All" : "Team", {
      game_size: DEFAULT_ANALYZER_FILTERS.game_size,
    });
  }

  const length = gameLengthLabel(filters.min_minutes, filters.max_minutes);
  if (length) add("length", length, { min_minutes: undefined, max_minutes: undefined });

  if (filters.exclude_too_short === false) {
    add("exclude_too_short", "Shown", { exclude_too_short: true });
  }

  const race = normalizeRaceCode(filters.race);
  if (race) add("race", coerceRace(race), { race: undefined });

  const oppRace = normalizeRaceCode(filters.opp_race);
  if (oppRace) add("opp_race", coerceRace(oppRace), { opp_race: undefined });

  if (filters.build) add("build", filters.build, { build: undefined }, "Strategies");

  if (filters.opp_strategy) {
    add("opp_strategy", filters.opp_strategy, { opp_strategy: undefined }, "Strategies");
  }

  if (filters.map) add("map", filters.map, { map: undefined });

  const mmr = mmrRangeLabel(filters.mmr_min, filters.mmr_max);
  if (mmr) add("mmr", mmr, { mmr_min: undefined, mmr_max: undefined });

  return out;
}

function presetValue(
  preset: PresetId,
  filters: AnalyzerFilters,
  seasons?: LogicalSeason[],
): string {
  if (preset !== "custom") return longLabelFor(preset, seasons);
  const since = formatChipDate(filters.since);
  const until = formatChipDate(filters.until);
  if (since && until) return `${since} – ${until}`;
  if (since) return `From ${since}`;
  if (until) return `Until ${until}`;
  return longLabelFor(preset, seasons);
}

function formatChipDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function mmrRangeLabel(min?: number, max?: number): string | null {
  const lo = typeof min === "number" && Number.isFinite(min) ? min : undefined;
  const hi = typeof max === "number" && Number.isFinite(max) ? max : undefined;
  if (lo !== undefined && hi !== undefined) return `${lo}–${hi}`;
  if (lo !== undefined) return `${lo}+`;
  if (hi !== undefined) return `Up to ${hi}`;
  return null;
}
