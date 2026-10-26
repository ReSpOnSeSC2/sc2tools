import { viewFiltersQuery } from "./analyzerViews";
import type { AnalyzerFilters } from "./filterContext";
import { SECTION_QUERY_KEYS } from "./sectionQueryKeys";
/** Keep known section state alongside a complete global snapshot. Unknown
 * query values such as a token are never copied into a shareable analyzer URL. */
export function sectionViewHref(path: string, search: string, filters: AnalyzerFilters) {
  const current = new URLSearchParams(search), query = viewFiltersQuery(filters);
  const value = (key: string) => {
    const values = current.getAll(key);
    return values.length === 1 && values[0].length <= 2048 && !/[\u0000-\u001f\u007f]/.test(values[0]) ? values[0] : null;
  };
  for (const key of SECTION_QUERY_KEYS) { const raw = value(key); if (raw) query.set(key, raw); }
  if (path === "/app/replays") for (const [legacy, key] of [["replaySearch", "q"], ["replayResult", "result"], ["replayMatchup", "matchup"], ["replaySort", "sort"]]) {
    const raw = value(legacy); if (!query.has(key) && raw) query.set(key, raw);
  }
  if (path === "/app/opponents" && query.has("sort") && !query.get("sort")!.includes(":")) query.set("sort", `${query.get("sort")}:${value("dir") === "asc" ? "asc" : "desc"}`);
  if (path === "/app" && !query.has("view")) query.set("view", "today");
  return `${path}${query.size ? `?${query}` : ""}`;
}
