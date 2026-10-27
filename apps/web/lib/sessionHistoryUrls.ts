import { filtersToQuery, type AnalyzerFilters } from "./filterContext";
import { viewFiltersFromQuery, viewFiltersQuery } from "./analyzerViews";
import type { SessionHistoryWindow } from "./sessionHistory";

export const SESSION_VIEW_KEYS = ["day", "tz", "windowFrom", "windowTo", "contextDays", "before", "gamesBefore", "gamesLimit", "sessionView", "sessionRolling"] as const;
const HISTORY_KEYS = ["day", "tz", "windowFrom", "windowTo", "contextDays", "before"];
const DETAIL_KEYS = ["tz", "contextDays", "gamesLimit", "gamesBefore"];
const CURRENT_KEYS = ["tz", "contextDays"];
const withQuery = (path: string, query: URLSearchParams) => query.size ? `${path}?${query}` : path;

/** A link freezes the resolved membership, independently of its output day. */
export function sessionScopeQuery(filters: AnalyzerFilters): URLSearchParams {
  const next = { ...filters };
  if (next.preset !== "custom") delete next.patch_era;
  const query = new URLSearchParams(filtersToQuery(next));
  query.set("filters", "1");
  query.set("preset", query.has("since") || query.has("until") || query.has("patch_era") ? "custom" : "all");
  query.set("map_pool", filters.map_pool ?? "all");
  query.set("game_size", filters.game_size ?? "all");
  query.set("exclude_too_short", String(filters.exclude_too_short === true));
  return query;
}

function copyKeys(target: URLSearchParams, source: URLSearchParams, keys: readonly string[]) {
  for (const key of keys) { const values = source.getAll(key); if (!values.length) continue; target.delete(key); for (const value of values) target.append(key, value); }
  return target;
}

export function sessionListQuery(filters: AnalyzerFilters, source: URLSearchParams, tz: string): URLSearchParams {
  const query = copyKeys(sessionScopeQuery(filters), source, HISTORY_KEYS);
  if (!query.has("tz")) query.set("tz", tz);
  if (source.get("sessionRolling") === "1") query.set("sessionRolling", "1");
  return query;
}

function apiMembership(query: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(query);
  for (const key of ["filters", "preset", ...SESSION_VIEW_KEYS]) next.delete(key);
  return next;
}

export function sessionDetailQuery(filters: AnalyzerFilters, source: URLSearchParams, tz: string): URLSearchParams {
  if (source.get("sessionView") === "current") {
    const query = copyKeys(new URLSearchParams({ tz, sessionView: "current" }), source, DETAIL_KEYS);
    return query;
  }
  return copyKeys(sessionListQuery(filters, source, tz), source, DETAIL_KEYS);
}
export function sessionListApi(query: URLSearchParams): string {
  const next = copyKeys(apiMembership(query), query, HISTORY_KEYS);
  next.set("limit", "20");
  return withQuery("/v1/sessions", next);
}

export function sessionCurrentApi(query: URLSearchParams): string {
  return withQuery("/v1/sessions/current", copyKeys(new URLSearchParams(), query, CURRENT_KEYS));
}

export function sessionDetailApi(id: string, query: URLSearchParams): string {
  const scope = query.get("sessionView") === "current" ? new URLSearchParams() : apiMembership(query);
  return withQuery(`/v1/sessions/${encodeURIComponent(id)}`, copyKeys(scope, query, DETAIL_KEYS));
}

export function sessionDetailHref(id: string, query: URLSearchParams, window?: SessionHistoryWindow, keepGames = false): string {
  const next = new URLSearchParams(query);
  if (!keepGames) { next.delete("gamesBefore"); next.delete("gamesLimit"); }
  if (window && !next.has("day")) { if (!next.has("windowFrom")) next.set("sessionRolling", "1"); next.set("windowFrom", window.from); next.set("windowTo", window.to); }
  return withQuery(`/app/sessions/${encodeURIComponent(id)}`, next);
}

export function sessionHistoryHref(filters: AnalyzerFilters, options: { day?: string; tz: string }): string {
  const query = sessionScopeQuery(filters); query.set("tz", options.tz);
  if (options.day) query.set("day", options.day);
  return withQuery("/app/sessions", query);
}

export function sessionHref(query: URLSearchParams): string { return withQuery("/app/sessions", query); }

export function sessionRestartQuery(query: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(query); next.delete("before"); next.delete("gamesBefore"); return next;
}

export function refreshSessionQuery(query: URLSearchParams): URLSearchParams {
  const next = sessionRestartQuery(query);
  if (next.get("sessionRolling") === "1") { next.delete("windowFrom"); next.delete("windowTo"); next.delete("sessionRolling"); }
  return next;
}
/** Scope/output/context changes retire both continuations. */
export function changeSessionQuery(query: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = sessionRestartQuery(query);
  for (const [key, value] of Object.entries(patch)) { if (value === null) next.delete(key); else next.set(key, value); }
  return next;
}

export function sessionScopeIsSynced(filters: AnalyzerFilters, source: URLSearchParams): boolean {
  const parsed = viewFiltersFromQuery(source);
  return !parsed.present || !parsed.error && viewFiltersQuery(parsed.filters).toString() === viewFiltersQuery(filters).toString();
}

function validSessionDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}

export function sessionTransportError(query: URLSearchParams): string | null {
  if (SESSION_VIEW_KEYS.some(key => query.getAll(key).length > 1)) return "Use one value per session view setting.";
  try { new Intl.DateTimeFormat("en-US", { timeZone: query.get("tz") ?? "UTC" }); }
  catch { return "Choose a valid timezone."; }
  const day = query.get("day");
  if (day && !validSessionDay(day)) return "Choose a valid calendar day.";
  if (day && (query.has("windowFrom") || query.has("windowTo"))) return "Choose a day or an output window.";
  return null;
}
