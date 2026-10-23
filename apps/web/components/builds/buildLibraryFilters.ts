import type { BuildFilterState } from "./BuildFilterBar";
import { COMMON_MATCHUPS, raceLetter } from "@/lib/race";

export const DEFAULT_BUILD_FILTERS: BuildFilterState = { search: "", matchup: "All", sort: "updated", hideEmpty: false };
const matchups = new Set(COMMON_MATCHUPS.map(({ my, vs }) => `${raceLetter(my)}v${raceLetter(vs)}`));
export function readBuildFilters(params: Pick<URLSearchParams, "get">): BuildFilterState {
  const sort = params.get("sort"); const matchup = params.get("mu");
  return { search: (params.get("q") || "").slice(0, 200), matchup: matchup && matchups.has(matchup) ? matchup : "All",
    sort: sort === "games" || sort === "winRate" || sort === "name" ? sort : "updated", hideEmpty: params.get("hide") === "1" };
}
export function buildFiltersQuery(filters: BuildFilterState): string {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set("q", filters.search.trim());
  if (filters.matchup !== "All") params.set("mu", filters.matchup);
  if (filters.sort !== "updated") params.set("sort", filters.sort);
  if (filters.hideEmpty) params.set("hide", "1");
  return params.toString();
}
export function activeBuildFilters(filters: BuildFilterState): string[] {
  return [...(filters.search ? [`Search ‘${filters.search}’`] : []), ...(filters.matchup !== "All" ? [filters.matchup] : []), ...(filters.hideEmpty ? ["Hide empty"] : [])];
}
