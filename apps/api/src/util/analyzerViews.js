"use strict";

const rules = require("../config/analyzerViews.json");
const { parseExactMapNames } = require("./exactMapFilter");
const plain = (/** @type {unknown} */ value) => !!value && typeof value === "object" && !Array.isArray(value);
const clean = (/** @type {unknown} */ value, /** @type {number} */ max) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";

/** Same wire keys as the analyzer; credentials, pagination and unknown fields
 * cannot be saved or reintroduced through a copied view.
 * @param {unknown} raw @returns {Record<string,unknown>} */
function sanitizeViewFilters(raw) {
  if (!plain(raw)) return {};
  const source = /** @type {Record<string,unknown>} */ (raw);
  /** @type {Record<string,unknown>} */ const out = {};
  const preset = clean(source.preset, 40);
  if (rules.presets.includes(preset) || /^season:[1-9]\d{0,4}$/.test(preset)) out.preset = preset;
  for (const key of ["since", "until"]) {
    const date = clean(source[key], 40);
    if (/^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(date) && Number.isFinite(Date.parse(date))) out[key] = new Date(date).toISOString();
  }
  for (const [key, max] of Object.entries(rules.strings)) { const value = clean(source[key], max); if (value) out[key] = value; }
  for (const [key, bounds] of Object.entries(rules.numbers)) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= bounds[0] && value <= bounds[1]) out[key] = Math.floor(value);
  }
  for (const [key, choices] of Object.entries(rules.choices)) {
    const value = clean(source[key], 20);
    if (choices.includes(value)) out[key] = value;
  }
  if (typeof source.exclude_too_short === "boolean") out.exclude_too_short = source.exclude_too_short;
  if (typeof source.regions === "string") {
    const values = new Set(source.regions.split(",").map((value) => value.trim().toUpperCase()));
    const regions = rules.regions.filter((value) => values.has(value));
    if (regions.length) out.regions = regions.join(",");
  }
  if (source.map_exact !== undefined && (source.map_exact_label === undefined || clean(source.map_exact_label, 200) === out.map)) {
    const names = parseExactMapNames(source.map_exact);
    out.map_exact = JSON.stringify(names);
    // An exact alias cohort stays tied to its visible Map chip.
    if (!names?.includes(String(out.map ?? ""))) out.map = names?.[0];
  }
  for (const [min, max] of [["mmr_min", "mmr_max"], ["macro_min", "macro_max"], ["min_minutes", "max_minutes"]]) {
    if (typeof out[min] === "number" && typeof out[max] === "number" && out[min] > out[max]) [out[min], out[max]] = [out[max], out[min]];
  }
  if (out.preset && out.preset !== "custom") { delete out.since; delete out.until; }
  else if (out.since || out.until) {
    out.preset = "custom";
    if (typeof out.since === "string" && typeof out.until === "string" && out.since > out.until) [out.since, out.until] = [out.until, out.since];
  }
  return out;
}

/** Bounded private preference; strict writes reject ambiguous or lost views.
 * @param {unknown} raw @param {boolean} [strict] @returns {{views:Array<{id:string,name:string,filters:Record<string,unknown>,section?:string}>,defaultViewId:string|null}} */
function sanitizeAnalyzerViews(raw, strict = false) {
  const fail = () => { throw Object.assign(new Error("Use up to 12 uniquely named views with valid filters."), { status: 400, code: "invalid_analyzer_views" }); };
  if (!plain(raw)) { if (strict) fail(); return { views: [], defaultViewId: null }; }
  const source = /** @type {Record<string,unknown>} */ (raw);
  if (source.views !== undefined && (!Array.isArray(source.views) || source.views.length > rules.maxViews)) { if (strict) fail(); }
  const rows = Array.isArray(source.views) ? source.views.slice(0, rules.maxViews) : [];
  /** @type {Array<{id:string,name:string,filters:Record<string,unknown>,section?:string}>} */ const views = [];
  const ids = new Set(), names = new Set();
  for (const rawView of rows) {
    const view = plain(rawView) ? /** @type {Record<string,unknown>} */ (rawView) : {};
    const id = clean(view.id, 64), name = clean(view.name, rules.maxName);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !name || ids.has(id) || names.has(name.toLowerCase()) || !plain(view.filters)
      || view.section !== undefined && !rules.sections.includes(String(view.section))) { if (strict) fail(); else continue; }
    /** @type {Record<string,unknown>} */ let filters = {};
    try { filters = sanitizeViewFilters(view.filters); } catch { if (strict) fail(); else continue; }
    ids.add(id); names.add(name.toLowerCase());
    views.push({ id, name, filters, ...(view.section ? { section: String(view.section) } : {}) });
  }
  const selected = typeof source.defaultViewId === "string" && ids.has(source.defaultViewId) ? source.defaultViewId : null;
  if (strict && source.defaultViewId != null && !selected) fail();
  return { views, defaultViewId: selected };
}

module.exports = { sanitizeViewFilters, sanitizeAnalyzerViews };
