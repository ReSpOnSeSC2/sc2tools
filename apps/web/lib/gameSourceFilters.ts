/** Only navigation's supported game filters may cross a page boundary. */
const KEYS = new Set(["since", "until", "patch_era", "race", "opp_race", "map", "map_exact", "mmr_min", "mmr_max", "opp_strategy", "group_by_race_played", "build", "leak", "macro_min", "macro_max", "min_minutes", "max_minutes", "exclude_too_short", "regions", "map_pool", "game_size", "result", "matchup", "q"]);

/** Drop credentials, pagination and unknown inputs; retain one bounded value per filter. */
export function gameSourceFilters(...queries: readonly (string | null | undefined)[]): string {
  const result = new URLSearchParams();
  for (const raw of queries) {
    if (typeof raw !== "string" || raw.length > 4096) continue;
    for (const [original, value] of new URLSearchParams(raw.replace(/^\?/, "").split("#", 1)[0])) {
      const key = original === "search" ? "q" : original;
      if (KEYS.has(key) && value.length <= (key === "map_exact" ? 2048 : 256) && !/[\u0000-\u001f\u007f]/.test(value)) result.set(key, value);
    }
  }
  return result.toString().length <= 4096 ? result.toString() : "";
}
