import type { AnalyzerFilters } from "@/lib/filterContext";

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
  if (p.selection === "include") return `${p.playerIds.length.toLocaleString()} selected`;
  return p.playerIds.length ? `${p.playerIds.length.toLocaleString()} excluded` : "All players";
}
