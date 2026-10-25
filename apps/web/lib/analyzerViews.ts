import rules from "../../api/src/config/analyzerViews.json";
import type { AnalyzerFilters } from "./filterContext";
import { accountFilter } from "./accountFilter";

export type AnalyzerView = { id: string; name: string; filters: AnalyzerFilters; section?: string };
export type AnalyzerViewPrefs = { views: AnalyzerView[]; defaultViewId: string | null };
export const ANALYZER_VIEW_LIMIT = rules.maxViews;
export const VIEW_QUERY_MARKER = "filters";
const NUMBER_KEYS = new Set(Object.keys(rules.numbers));
export const VIEW_FILTER_KEYS = ["preset", "since", "until", ...Object.keys(rules.strings), ...Object.keys(rules.numbers), ...Object.keys(rules.choices), ...rules.accountKeys, "exclude_too_short", "regions", "map_exact"];
const clean = (value: unknown, max: number) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Safe URL/storage input; unknown keys never enter the shared filter object. */
export function sanitizeViewFilters(raw: unknown): AnalyzerFilters {
  if (!plain(raw)) return {};
  const out: Record<string, unknown> = {};
  const preset = clean(raw.preset, 40);
  if (rules.presets.includes(preset) || /^season:[1-9]\d{0,4}$/.test(preset)) out.preset = preset;
  for (const key of ["since", "until"]) {
    const date = clean(raw[key], 40);
    if (/^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(date) && Number.isFinite(Date.parse(date))) out[key] = new Date(date).toISOString();
  }
  for (const [key, max] of Object.entries(rules.strings)) { const value = clean(raw[key], max); if (value) out[key] = value; }
  for (const [key, bounds] of Object.entries(rules.numbers)) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= bounds[0] && value <= bounds[1]) out[key] = Math.floor(value);
  }
  for (const [key, choices] of Object.entries(rules.choices)) { const value = clean(raw[key], 20); if (choices.includes(value)) out[key] = value; }
  if (typeof raw.exclude_too_short === "boolean") out.exclude_too_short = raw.exclude_too_short;
  if (raw.accounts !== undefined) { const accounts = accountFilter(raw.accounts); if (accounts) out.accounts = accounts; }
  if (typeof raw.regions === "string") {
    const values = new Set(raw.regions.split(",").map(value => value.trim().toUpperCase()));
    const regions = rules.regions.filter(value => values.has(value));
    if (regions.length) out.regions = regions.join(",");
  }
  if (raw.map_exact !== undefined && (raw.map_exact_label === undefined || clean(raw.map_exact_label, 200) === out.map)) {
    let names: unknown;
    try { names = typeof raw.map_exact === "string" && raw.map_exact.length <= 2048 ? JSON.parse(raw.map_exact) : null; } catch { names = null; }
    if (Array.isArray(names) && names.length > 0 && names.length <= 16 && names.every(name => typeof name === "string" && name.trim() && name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(name)) && encodeURIComponent(JSON.stringify(names)).length <= 2048) {
      out.map_exact = JSON.stringify([...new Set(names)]);
      if (!names.includes(out.map)) out.map = names[0];
      out.map_exact_label = out.map;
    } else throw new Error("This view has an invalid exact map cohort.");
  }
  for (const [min, max] of [["mmr_min", "mmr_max"], ["macro_min", "macro_max"], ["min_minutes", "max_minutes"]]) {
    if (typeof out[min] === "number" && typeof out[max] === "number" && out[min] > out[max]) [out[min], out[max]] = [out[max], out[min]];
  }
  if (out.preset && out.preset !== "custom") { delete out.since; delete out.until; }
  else if (out.since || out.until) {
    out.preset = "custom";
    if (typeof out.since === "string" && typeof out.until === "string" && out.since > out.until) [out.since, out.until] = [out.until, out.since];
  }
  return out as AnalyzerFilters;
}

export function viewFiltersFromQuery(query: URLSearchParams): { present: boolean; snapshot: boolean; keys: string[]; filters: AnalyzerFilters; error?: string } {
  if (query.getAll("accounts").length > 1) return { present: true, snapshot: query.get(VIEW_QUERY_MARKER) === "1", keys: ["accounts"], filters: {}, error: "Use one accounts parameter with up to 20 valid account handles." };
  const raw: Record<string, unknown> = {};
  for (const key of VIEW_FILTER_KEYS) {
    const value = query.get(key); if (value === null) continue;
    raw[key] = NUMBER_KEYS.has(key) ? value.trim() ? Number(value) : undefined : key === "exclude_too_short" ? value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : undefined : value;
  }
  const keys = VIEW_FILTER_KEYS.filter(key => query.has(key));
  const snapshot = query.get(VIEW_QUERY_MARKER) === "1";
  try { return { present: snapshot || keys.length > 0, snapshot, keys, filters: sanitizeViewFilters(raw) }; }
  catch (error) { return { present: true, snapshot, keys, filters: {}, error: error instanceof Error ? error.message : "This view has invalid filters." }; }
}

/** A preset remains relative when reopened; derived dates are not frozen. */
export function viewFiltersQuery(filters: AnalyzerFilters): URLSearchParams {
  const safe = sanitizeViewFilters(filters) as Record<string, unknown>, query = new URLSearchParams();
  query.set(VIEW_QUERY_MARKER, "1");
  for (const key of VIEW_FILTER_KEYS) { const value = safe[key]; if (value !== undefined && value !== null && value !== "") query.set(key, String(value)); }
  return query;
}

export function replaceViewQuery(current: string, filters: AnalyzerFilters): string {
  const query = new URLSearchParams(current);
  query.delete(VIEW_QUERY_MARKER);
  for (const key of VIEW_FILTER_KEYS) query.delete(key);
  for (const [key, value] of viewFiltersQuery(filters)) query.set(key, value);
  return query.toString();
}

export function isAnalyzerViewPath(path: string): boolean {
  return path === "/app" || rules.sections.some(section => section !== "today" && path === `/app/${section}`);
}

export function analyzerViewHref(view: Pick<AnalyzerView, "filters" | "section">): string {
  const section = rules.sections.includes(view.section ?? "") ? view.section : "today";
  const query = viewFiltersQuery(view.filters);
  if (section === "today") query.set("view", "today");
  const path = !section || section === "today" ? "/app" : `/app/${section}`;
  return query.size ? `${path}?${query}` : path;
}

export function sanitizeAnalyzerViews(raw: unknown): AnalyzerViewPrefs {
  if (!plain(raw)) return { views: [], defaultViewId: null };
  const ids = new Set<string>(), names = new Set<string>();
  const views: AnalyzerView[] = [];
  for (const row of (Array.isArray(raw.views) ? raw.views : []).slice(0, ANALYZER_VIEW_LIMIT)) {
    if (!plain(row)) continue;
    const id = clean(row.id, 64), name = clean(row.name, rules.maxName);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !name || ids.has(id) || names.has(name.toLowerCase()) || !plain(row.filters) || row.section !== undefined && !rules.sections.includes(String(row.section))) continue;
    let filters: AnalyzerFilters;
    try { filters = sanitizeViewFilters(row.filters); } catch { continue; }
    ids.add(id); names.add(name.toLowerCase());
    views.push({ id, name, filters, ...(row.section ? { section: String(row.section) } : {}) });
  }
  return { views, defaultViewId: typeof raw.defaultViewId === "string" && ids.has(raw.defaultViewId) ? raw.defaultViewId : null };
}
