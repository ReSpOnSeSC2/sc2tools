import { filtersToQuery, type AnalyzerFilters } from "./filterContext";
import { replaceViewQuery, viewFiltersFromQuery, viewFiltersQuery } from "./analyzerViews";
import type { SessionHistoryWindow } from "./sessionHistory";
import { SESSION_SCOPE_KEYS, hasScopeInput, isSessionViewPath, scopeKey, sessionScopeIsSynced, sessionScopeTransportError } from "./sessionScopeAdmission";
export { SESSION_SCOPE_KEYS, isSessionViewPath, sessionScopeIsSynced, sessionScopeTransportError, sessionViewIsAutomaticSameCohort } from "./sessionScopeAdmission";

const SCOPE_BOUNDS = [["scopeSince", "since"], ["scopeUntil", "until"], ["scopePatch", "patch_era"]] as const;

export const SESSION_VIEW_KEYS = ["day", "tz", "windowFrom", "windowTo", "contextDays", "before", "gamesBefore", "gamesLimit", "sessionView", "sessionRolling", ...SESSION_SCOPE_KEYS] as const;
const HISTORY_KEYS = ["day", "tz", "windowFrom", "windowTo", "contextDays", "before"];
const DETAIL_KEYS = ["tz", "contextDays", "gamesLimit", "gamesBefore"];
const CURRENT_KEYS = ["tz", "contextDays"];
const withQuery = (path: string, query: URLSearchParams) => query.size ? `${path}?${query}` : path;

/** Versioned membership bounds are transport only, never the global preset. */
export function sessionScopeQuery(filters: AnalyzerFilters): URLSearchParams {
  const semantic = viewFiltersQuery(filters);
  const resolved = { ...filters };
  if (resolved.preset !== "custom") delete resolved.patch_era;
  const membership = new URLSearchParams(filtersToQuery(resolved));
  semantic.set("sessionScope", "1");
  for (const [local, api] of SCOPE_BOUNDS) {
    const value = membership.get(api); if (value !== null) semantic.set(local, value);
  }
  semantic.set("map_pool", filters.map_pool ?? "all");
  semantic.set("game_size", filters.game_size ?? "all");
  semantic.set("exclude_too_short", String(filters.exclude_too_short === true));
  return semantic;
}

function copyKeys(target: URLSearchParams, source: URLSearchParams, keys: readonly string[]) {
  for (const key of keys) { const values = source.getAll(key); if (!values.length) continue; target.delete(key); for (const value of values) target.append(key, value); }
  return target;
}
function clearScope(query: URLSearchParams) { for (const key of [...query.keys()]) if (scopeKey(key)) query.delete(key); return query; }
function copyScope(target: URLSearchParams, source: URLSearchParams) { return copyKeys(target, source, [...new Set(source.keys())].filter(scopeKey)); }
function frozenOutput(query: URLSearchParams): boolean {
  return ["day", "windowFrom", "windowTo", "before", "gamesBefore"].some(key => query.has(key));
}

/** Latest lists recapture Auto bounds; reports/output/continuations retain exact membership. */
function scopedQuery(filters: AnalyzerFilters, source: URLSearchParams, mode: "latest" | "frozen"): URLSearchParams {
  const next = sessionScopeQuery(filters);
  const invalid = sessionScopeTransportError(source);
  if (invalid || hasScopeInput(source) && mode === "frozen" && source.get("scopeRefresh") !== "1" && sessionScopeIsSynced(filters, source)) {
    clearScope(next); copyScope(next, source);
  }
  return next;
}
export function sessionListQuery(filters: AnalyzerFilters, source: URLSearchParams, tz: string): URLSearchParams {
  const query = copyKeys(scopedQuery(filters, source, frozenOutput(source) ? "frozen" : "latest"), source, HISTORY_KEYS);
  if (!query.has("tz")) query.set("tz", tz);
  if (source.get("sessionRolling") === "1") query.set("sessionRolling", "1");
  return query;
}

/** A marked scope uses only its prefixed bounds; absence means unbounded, not UI dates. */
function apiMembership(query: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(query);
  for (const key of ["filters", "preset", ...SESSION_VIEW_KEYS]) next.delete(key);
  clearScope(next);
  if (hasScopeInput(query)) {
    for (const [, api] of SCOPE_BOUNDS) next.delete(api);
    for (const [local, api] of SCOPE_BOUNDS) { const value = query.get(local); if (value !== null) next.set(api, value); }
  }
  return next;
}

export function sessionDetailQuery(filters: AnalyzerFilters, source: URLSearchParams, tz: string): URLSearchParams {
  if (source.get("sessionView") === "current") {
    const query = copyKeys(new URLSearchParams({ tz, sessionView: "current" }), source, DETAIL_KEYS);
    if (sessionScopeTransportError(source)) copyScope(query, source);
    return query;
  }
  const query = copyKeys(scopedQuery(filters, source, "frozen"), source, HISTORY_KEYS);
  if (!query.has("tz")) query.set("tz", tz);
  if (source.get("sessionRolling") === "1") query.set("sessionRolling", "1");
  return copyKeys(query, source, DETAIL_KEYS);
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
  if (next.get("sessionScope") === "1") {
    for (const [local] of SCOPE_BOUNDS) next.delete(local);
    next.set("scopeRefresh", "1");
  }
  return next;
}
/** Scope/output/context changes retire both continuations. */
export function changeSessionQuery(query: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = sessionRestartQuery(query);
  for (const [key, value] of Object.entries(patch)) { if (value === null) next.delete(key); else next.set(key, value); }
  return next;
}

function keepFrozenScope(source: URLSearchParams, path: string, same: boolean, recapture: boolean): boolean {
  return !recapture && same && (path !== "/app/sessions" || frozenOutput(source))
    && hasScopeInput(source) && source.get("scopeRefresh") !== "1";
}
function exportSessionScope(current: string, source: URLSearchParams, next: URLSearchParams,
  filters: AnalyzerFilters, path: string, recapture: boolean): string {
  if (!recapture && sessionScopeTransportError(source)) return current;
  const same = sessionScopeIsSynced(filters, source);
  clearScope(next); copyScope(next, keepFrozenScope(source, path, same, recapture) ? source : sessionScopeQuery(filters));
  if (!same || recapture || source.get("scopeRefresh") === "1") { next.delete("before"); next.delete("gamesBefore"); }
  return next.toString();
}
/** Keep generic copied Views generic; only generated/bare Session routes gain a scope marker. */
export function replaceSessionViewQuery(current: string, filters: AnalyzerFilters, path: string, recapture = false): string {
  const source = new URLSearchParams(current), next = new URLSearchParams(replaceViewQuery(current, filters));
  if (!isSessionViewPath(path)) {
    if (hasScopeInput(source)) { for (const key of SESSION_VIEW_KEYS) next.delete(key); clearScope(next); }
    return next.toString();
  }
  const parsed = viewFiltersFromQuery(source);
  if (parsed.present && !hasScopeInput(source)) {
    if (!sessionScopeIsSynced(filters, source)) { next.delete("before"); next.delete("gamesBefore"); }
    return next.toString();
  }
  return exportSessionScope(current, source, next, filters, path, recapture);
}
function validSessionDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}
export function sessionTransportError(query: URLSearchParams): string | null {
  if (SESSION_VIEW_KEYS.some(key => query.getAll(key).length > 1)) return "Use one value per session view setting.";
  const scopeError = sessionScopeTransportError(query); if (scopeError) return scopeError;
  try { new Intl.DateTimeFormat("en-US", { timeZone: query.get("tz") ?? "UTC" }); }
  catch { return "Choose a valid timezone."; }
  const day = query.get("day");
  if (day && !validSessionDay(day)) return "Choose a valid calendar day.";
  if (day && (query.has("windowFrom") || query.has("windowTo"))) return "Choose a day or an output window.";
  return null;
}
