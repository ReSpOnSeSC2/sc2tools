import type { AnalyzerFilters } from "./filterContext";
import { viewFiltersFromQuery, viewFiltersQuery } from "./analyzerViews";

export const SESSION_SCOPE_KEYS = ["sessionScope", "scopeSince", "scopeUntil", "scopePatch", "scopeRefresh"] as const;
export const scopeKey = (key: string) => key === "sessionScope" || key.startsWith("scope");
export const hasScopeInput = (query: URLSearchParams) => [...query.keys()].some(scopeKey);
export const isSessionViewPath = (path: string) => path === "/app/sessions" || path.startsWith("/app/sessions/");

function canonicalScopeDate(value: string): boolean {
  if (value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Invalid transport must remain visible to callers; never silently recapture it. */
function scopeSettingsError(query: URLSearchParams): string | null {
  if ([...query.keys()].some(key => scopeKey(key) && !SESSION_SCOPE_KEYS.some(known => known === key))) return "Use supported session membership settings.";
  if (SESSION_SCOPE_KEYS.some(key => query.getAll(key).length > 1)) return "Use one value per session membership setting.";
  if (query.get("sessionScope") !== "1") return "Use a supported session membership version.";
  if (query.has("scopeRefresh") && query.get("scopeRefresh") !== "1") return "Use a valid session refresh setting.";
  return null;
}
function scopeBoundsError(query: URLSearchParams): string | null {
  for (const key of ["scopeSince", "scopeUntil"] as const) {
    const value = query.get(key); if (value !== null && !canonicalScopeDate(value)) return "Use valid ISO session membership bounds.";
  }
  const since = query.get("scopeSince"), until = query.get("scopeUntil");
  if (since !== null && until !== null && since > until) return "Session membership start must not follow its end.";
  if (query.has("scopePatch") && !["before", "after"].includes(query.get("scopePatch") ?? "")) return "Use a valid session version cohort.";
  return null;
}
export function sessionScopeTransportError(query: URLSearchParams): string | null {
  if (!hasScopeInput(query)) return null;
  return scopeSettingsError(query) ?? scopeBoundsError(query);
}

export function sessionScopeIsSynced(filters: AnalyzerFilters, source: URLSearchParams): boolean {
  if (sessionScopeTransportError(source)) return false;
  const parsed = viewFiltersFromQuery(source);
  return !parsed.present || !parsed.error && viewFiltersQuery(parsed.filters).toString() === viewFiltersQuery(filters).toString();
}
/** This exception never clears an already active generic copied-view lifetime. */
export function sessionViewIsAutomaticSameCohort(path: string, source: URLSearchParams, filters: AnalyzerFilters): boolean {
  return isSessionViewPath(path) && hasScopeInput(source) && sessionScopeIsSynced(filters, source);
}
