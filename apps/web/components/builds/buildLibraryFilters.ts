import type { BuildFilterState } from "./BuildFilterBar";
import { COMMON_MATCHUPS, raceLetter } from "@/lib/race";
import { normalizeTags } from "@/lib/buildLibrary";

export const DEFAULT_BUILD_FILTERS: BuildFilterState = {
  search: "", matchup: "All", sort: "updated", hideEmpty: false,
  source: "all", published: false, race: "", tags: [],
};
const matchups = new Set(COMMON_MATCHUPS.map(({ my, vs }) => `${raceLetter(my)}v${raceLetter(vs)}`));

/**
 * URL → filters: q, mu, sort, hide, src (mine | opp), pub=1, race (P | T | Z)
 * and tags (comma separated). Unknown values fall back to the default.
 */
export function readBuildFilters(params: Pick<URLSearchParams, "get">): BuildFilterState {
  const sort = params.get("sort"); const matchup = params.get("mu");
  const src = params.get("src"); const race = params.get("race");
  const validMatchup = matchup && matchups.has(matchup) ? matchup : "All";
  return {
    search: (params.get("q") || "").slice(0, 200), matchup: validMatchup,
    sort: sort === "games" || sort === "winRate" || sort === "name" || sort === "lastPlayed" ? sort : "updated",
    hideEmpty: params.get("hide") === "1",
    source: src === "mine" || src === "opp" ? src : "all",
    published: params.get("pub") === "1",
    // A matchup implies its race.
    race: validMatchup !== "All" ? validMatchup[0] as BuildFilterState["race"] : race === "P" || race === "T" || race === "Z" ? race : "",
    tags: normalizeTags((params.get("tags") || "").split(",")),
  };
}

export function buildFiltersQuery(filters: BuildFilterState): string {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("q", filters.search.trim());
  if (filters.matchup !== "All") params.set("mu", filters.matchup);
  if (filters.sort !== "updated") params.set("sort", filters.sort);
  if (filters.hideEmpty) params.set("hide", "1");
  if (filters.source !== "all") params.set("src", filters.source);
  if (filters.published) params.set("pub", "1");
  if (filters.race && filters.matchup === "All") params.set("race", filters.race);
  if (filters.tags.length) params.set("tags", filters.tags.join(","));
  return params.toString();
}

const RACE_NAMES = { P: "Protoss", T: "Terran", Z: "Zerg" } as const;

export function activeBuildFilters(filters: BuildFilterState): string[] {
  return [
    ...(filters.search ? [`Search ‘${filters.search}’`] : []),
    ...(filters.matchup !== "All" ? [filters.matchup] : filters.race ? [RACE_NAMES[filters.race]] : []),
    ...(filters.hideEmpty ? ["Hide empty"] : []),
    ...(filters.source === "mine" ? ["Mine"] : filters.source === "opp" ? ["Opponent captures"] : []),
    ...(filters.published ? ["Published"] : []),
    ...filters.tags.map((tag) => `#${tag}`),
  ];
}

/** How many filters "Clear filters (n)" clears. */
export function activeBuildFilterCount(filters: BuildFilterState): number {
  return activeBuildFilters(filters).length;
}

/** The library page request's filter params (API names). */
export function buildFilterApiQuery(filters: BuildFilterState) {
  return {
    perspective: filters.source === "mine" ? "you" as const : filters.source === "opp" ? "opponent" as const : undefined,
    published: filters.published || undefined,
    race: filters.matchup === "All" && filters.race ? filters.race : undefined,
    tags: filters.tags.length ? filters.tags : undefined,
  };
}
