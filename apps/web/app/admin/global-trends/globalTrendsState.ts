import type { AnalyzerFilters } from "@/lib/filterContext";
import { VIEW_FILTER_KEYS, VIEW_QUERY_MARKER, sanitizeViewFilters, viewFiltersFromQuery, viewFiltersQuery } from "@/lib/analyzerViews";
import { resolvePreset } from "@/lib/datePresets";
import type { LogicalSeason } from "@/lib/useSeasons";
import rules from "../../../../api/src/config/adminTrendViews.json";
import { formatNumber } from "@/lib/i18n/format";

export const ALL_GAME_FILTERS: AnalyzerFilters = {
  preset: "all", map_pool: "all", game_size: "all", exclude_too_short: false,
};

export const RACES = [
  { value: "P", label: "Protoss" },
  { value: "T", label: "Terran" },
  { value: "Z", label: "Zerg" },
  { value: "R", label: "Random" },
  { value: "U", label: "Unknown" },
] as const;

export type Population = {
  excludedRaces: string[];
  selection: "all" | "include";
  playerIds: string[];
  mmrMin: string;
  mmrMax: string;
  includeUnrated: boolean;
};

export const ALL_PLAYERS: Population = {
  excludedRaces: [], selection: "all", playerIds: [],
  mmrMin: "", mmrMax: "", includeUnrated: true,
};

export type TrendPlayer = {
  playerId: string;
  displayName: string;
  race: string;
  currentMmr: number | null;
  mmrSource: string | null;
  mmrUpdatedAt: string | null;
  gameCount: number;
  lastSeen: string | null;
  included: boolean;
};

export type TrendPlayersResponse = {
  items: TrendPlayer[];
  total: number;
  rosterTotal?: number;
  page: number;
  limit: number;
  hasMore: boolean;
  selectedTotal: number;
};

export type TrendFilterOptions = {
  maps: string[];
  builds: string[];
  strategies: string[];
};

export function populationQuery(p: Population) {
  return {
    excluded_races: [...p.excludedRaces].sort().join(",") || undefined,
    player_selection: p.selection,
    excluded_players: p.selection === "all" ? [...p.playerIds].sort().join(",") || undefined : undefined,
    included_players: p.selection === "include" ? [...p.playerIds].sort().join(",") || undefined : undefined,
    player_mmr_min: p.mmrMin === "" ? undefined : Number(p.mmrMin),
    player_mmr_max: p.mmrMax === "" ? undefined : Number(p.mmrMax),
    include_unrated: p.includeUnrated,
  };
}

export function mmrRangeError(min: string, max: string): string | null {
  if ([min, max].some((v) => v !== "" && (!/^\d+$/.test(v) || Number(v) > 10000))) {
    return "Enter an MMR from 0 to 10,000, or leave the field blank.";
  }
  if (min !== "" && max !== "" && Number(min) > Number(max)) {
    return "Minimum MMR must be less than or equal to maximum MMR.";
  }
  return null;
}

export function isPlayerSelected(p: Population, id: string): boolean {
  return p.selection === "include" ? p.playerIds.includes(id) : !p.playerIds.includes(id);
}

export function selectPlayers(p: Population, ids: string[], selected: boolean): Population {
  const next = new Set(p.playerIds);
  const add = p.selection === "include" ? selected : !selected;
  ids.forEach((id) => add ? next.add(id) : next.delete(id));
  return { ...p, playerIds: [...next].sort() };
}

export function selectionLabel(p: Population): string {
  if (p.selection === "include") return `${formatNumber(p.playerIds.length)} selected`;
  return p.playerIds.length ? `${formatNumber(p.playerIds.length)} excluded` : "All players";
}


export const ADMIN_TREND_VIEW_LIMIT = rules.maxViews;
export const LINK_PLAYERS_LIMIT = rules.maxLinkPlayers;
export const PRIVATE_PLAYERS_LIMIT = rules.maxSavedPlayers;
export const PLAYER_REF = new RegExp(rules.playerRefPattern);
export const TREND_VIEWS_PREF_PATH = `/v1/me/preferences/${rules.preferenceType}`;

export type TrendView = { filters: AnalyzerFilters; population: Population };
export type SavedTrendView = TrendView & { id: string; name: string };
export type TrendViewPreferences = { revision: number; views: SavedTrendView[] };
export type TrendDraft = TrendView & { opponentMin: string; opponentMax: string };

export const DEFAULT_TREND_VIEW: TrendView = { filters: ALL_GAME_FILTERS, population: ALL_PLAYERS };

export const BUILT_IN_VIEWS: SavedTrendView[] = [
  { id: "exclude-random", name: "Exclude Random", ...DEFAULT_TREND_VIEW, population: { ...ALL_PLAYERS, excludedRaces: ["R"] } },
  { id: "rated-only", name: "Rated players only", ...DEFAULT_TREND_VIEW, population: { ...ALL_PLAYERS, includeUnrated: false } },
  { id: "high-mmr", name: "High MMR (5000+)", ...DEFAULT_TREND_VIEW, population: { ...ALL_PLAYERS, mmrMin: "5000" } },
];

const POPULATION_KEYS = ["xr", "sel", "pids", "mmin", "mmax", "unrated"];
const QUERY_KEYS = [VIEW_QUERY_MARKER, ...VIEW_FILTER_KEYS, ...POPULATION_KEYS];
export const TREND_QUERY_DEFAULTS = Object.fromEntries(QUERY_KEYS.map(key => [key, ""]));

export function trendQueryPatch(query: URLSearchParams) {
  return Object.fromEntries(QUERY_KEYS.map(key => [key, query.get(key) ?? ""]));
}

export function trendQuerySignature(query: URLSearchParams) {
  return JSON.stringify(QUERY_KEYS.map(key => query.getAll(key)));
}

export function canonicalGameFilters(filters: AnalyzerFilters): AnalyzerFilters {
  const { accounts: _accounts, ...allowed } = filters;
  return { ...ALL_GAME_FILTERS, ...sanitizeViewFilters(allowed) };
}

export function chartFilters(filters: AnalyzerFilters, seasons: LogicalSeason[]) {
  const preset = filters.preset;
  if (!preset || preset === "custom") return filters;
  const range = resolvePreset(preset, undefined, seasons);
  return { ...filters, since: range.since?.toISOString(), until: range.until?.toISOString() };
}

export function trendViewQuery(view: TrendView) {
  const query = viewFiltersQuery(canonicalGameFilters(view.filters));
  const p = view.population;
  if (p.excludedRaces.length) query.set("xr", [...p.excludedRaces].sort().join(","));
  if (p.selection === "include") query.set("sel", "include");
  if (p.playerIds.length > 0 && p.playerIds.length <= LINK_PLAYERS_LIMIT) query.set("pids", [...p.playerIds].sort().join(","));
  if (p.mmrMin !== "") query.set("mmin", p.mmrMin);
  if (p.mmrMax !== "") query.set("mmax", p.mmrMax);
  if (!p.includeUnrated) query.set("unrated", "0");
  return query;
}

/** Decode only explicit known keys. Player selection uses opaque references. */
export function readTrendView(query: URLSearchParams) {
  const valid = new URLSearchParams();
  let malformed = false;
  for (const key of QUERY_KEYS) {
    const values = query.getAll(key);
    if (key === "accounts" && values.length || values.length > 1 || values.length === 1 && !values[0]) malformed = true;
    else if (values.length === 1) valid.set(key, values[0]);
  }
  const pairedRanges = [["since", "until"], ["mmr_min", "mmr_max"], ["macro_min", "macro_max"], ["min_minutes", "max_minutes"]];
  for (const [min, max] of pairedRanges) {
    const start = valid.get(min), end = valid.get(max);
    if (start === null || end === null) continue;
    const measure = min === "since" ? Date.parse : Number;
    if (measure(start) > measure(end)) {
      valid.delete(min); valid.delete(max); malformed = true;
    }
  }
  let shared = viewFiltersFromQuery(valid);
  if (shared.error) {
    malformed = true;
    valid.delete("map_exact");
    shared = viewFiltersFromQuery(valid);
  }
  for (const key of VIEW_FILTER_KEYS) {
    const raw = valid.get(key);
    const derivedDate = (key === "since" || key === "until") && shared.filters.preset && shared.filters.preset !== "custom";
    if (raw !== null && !(key in shared.filters) && !derivedDate) malformed = true;
  }
  const get = (key: string) => valid.get(key) || "";
  const excludedRaces = get("xr") ? [...new Set(get("xr").split(","))].sort() : [];
  const playerIds = get("pids") ? [...new Set(get("pids").split(","))].sort() : [];
  const badRaces = excludedRaces.some(value => !rules.raceCodes.includes(value));
  const badIds = playerIds.length > LINK_PLAYERS_LIMIT || playerIds.some(id => !PLAYER_REF.test(id));
  const selection = get("sel"), unrated = get("unrated");
  const mmrMin = get("mmin"), mmrMax = get("mmax");
  const badMmr = !!mmrRangeError(mmrMin, mmrMax);
  malformed ||= badRaces || badIds || badMmr || !["", "all", "include"].includes(selection) || !["", "0", "1"].includes(unrated);
  const view: TrendView = {
    filters: canonicalGameFilters(shared.filters),
    population: {
      excludedRaces: badRaces ? [] : excludedRaces,
      playerIds: badIds ? [] : playerIds,
      selection: selection === "include" ? "include" : "all",
      mmrMin: badMmr || mmrMin === "" ? "" : String(Number(mmrMin)),
      mmrMax: badMmr || mmrMax === "" ? "" : String(Number(mmrMax)),
      includeUnrated: unrated !== "0",
    },
  };
  return { view, malformed, unsafeIds: query.has("accounts") || badIds || query.getAll("pids").length > 1 };
}

export function trendDraft(view: TrendView): TrendDraft {
  return { ...view, opponentMin: view.filters.mmr_min?.toString() ?? "", opponentMax: view.filters.mmr_max?.toString() ?? "" };
}

export function viewFromDraft(draft: TrendDraft): TrendView {
  const filters = canonicalGameFilters({ ...draft.filters,
    mmr_min: draft.opponentMin === "" ? undefined : Number(draft.opponentMin),
    mmr_max: draft.opponentMax === "" ? undefined : Number(draft.opponentMax),
  });
  const p = draft.population;
  return { filters, population: { ...p,
    mmrMin: p.mmrMin === "" ? "" : String(Number(p.mmrMin)), mmrMax: p.mmrMax === "" ? "" : String(Number(p.mmrMax)),
    excludedRaces: [...p.excludedRaces].sort(), playerIds: [...p.playerIds].sort(),
  } };
}

function draftValues(draft: TrendDraft) {
  const { preset, since, until, mmr_min: _min, mmr_max: _max, map, map_exact, map_exact_label: _label, ...filters } = draft.filters;
  const p = draft.population;
  return { ...filters, date: JSON.stringify([preset, ...(preset === "custom" ? [since, until] : [])]),
    map: JSON.stringify([map || undefined, map_exact]), opponentMin: draft.opponentMin, opponentMax: draft.opponentMax,
    populationMin: p.mmrMin, populationMax: p.mmrMax, selection: p.selection, includeUnrated: p.includeUnrated,
    excludedRaces: [...p.excludedRaces].sort().join(","), playerIds: [...p.playerIds].sort().join(","),
  } as Record<string, unknown>;
}

export function countTrendChanges(applied: TrendView, draft: TrendDraft) {
  const before = draftValues(trendDraft(applied));
  const after = draftValues(draft);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]).length;
}
