import { accountFilter } from "./accountFilter";

/** Only navigation's supported game filters may cross a page boundary. */
const KEYS = new Set(["since", "until", "patch_era", "race", "opp_race", "map", "map_exact", "mmr_min", "mmr_max", "opp_strategy", "group_by_race_played", "build", "leak", "macro_min", "macro_max", "min_minutes", "max_minutes", "exclude_too_short", "regions", "map_pool", "game_size", "result", "matchup", "q"]);

/** Drop credentials, pagination and unknown inputs; retain one bounded value per filter. */
export function gameSourceFilters(...queries: readonly (string | null | undefined)[]): string {
  const result = new URLSearchParams();
  for (const raw of queries) {
    if (typeof raw !== "string") continue;
    if (raw.length > 4096) { if (/(?:^|[?&])accounts=/.test(raw)) result.set("accounts", "!"); continue; }
    const params = new URLSearchParams(raw.replace(/^\?/, "").split("#", 1)[0]);
    const repeatedAccounts = params.getAll("accounts").length > 1;
    for (const [original, value] of params) {
      const key = original === "search" ? "q" : original;
      if (key === "accounts") {
        // Invalid explicit membership stays invalid at the strict API boundary;
        // dropping it would silently navigate through every account instead.
        try { result.set(key, repeatedAccounts ? "!" : accountFilter(value) ?? ""); }
        catch { result.set(key, "!"); }
        continue;
      }
      if (KEYS.has(key) && value.length <= (key === "map_exact" ? 2048 : 256) && !/[\u0000-\u001f\u007f]/.test(value)) result.set(key, value);
    }
  }
  return result.toString().length <= 4096 ? result.toString() : result.has("accounts") ? "accounts=%21" : "";
}
