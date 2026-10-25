"use strict";
const rules = require("../../../web/lib/overlayProfileRules.json");
const THEME_KEYS = new Set(["accent", "scale", "opacity", "radius", "font", "style"]);
const plain = (/** @type {unknown} */ value) => !!value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => Object.assign(new Error("Use a valid overlay profile, theme and display time."), { status: 400, code: "invalid_overlay_profile" });
/** @returns {{v:1,theme:Record<string,any>,widgetOptions:Record<string,{durationSec:number|null}>}} */
function defaultOverlayProfile() { return { v: 1, theme: {}, widgetOptions: {} }; }

/** API writes reject hostile fields; opacity alone follows the existing clamp.
 * @param {unknown} raw @returns {Record<string,any>} */
function validateProfileTheme(raw) {
  if (!plain(raw)) throw invalid();
  const input = /** @type {Record<string,any>} */ (raw), theme = /** @type {Record<string,any>} */ ({});
  if (Object.keys(input).some(key => !THEME_KEYS.has(key))) throw invalid();
  if (Object.hasOwn(input, "accent")) {
    if (typeof input.accent !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(input.accent)) throw invalid();
    theme.accent = input.accent.toLowerCase();
  }
  if (Object.hasOwn(input, "scale")) {
    if (!rules.theme.scales.includes(input.scale)) throw invalid();
    if (input.scale !== 1) theme.scale = input.scale;
  }
  if (Object.hasOwn(input, "opacity")) {
    if (typeof input.opacity !== "number" || !Number.isFinite(input.opacity)) throw invalid();
    const value = Math.round(Math.min(1, Math.max(0, input.opacity)) * 100) / 100;
    if (value !== 0.94) theme.opacity = value;
  }
  /** @type {Array<[string, readonly string[], string|null]>} */
  const enums = [["radius", rules.theme.radii, "rounded"], ["font", rules.theme.fonts, "default"], ["style", rules.theme.styles, null]];
  for (const [key, choices, defaultValue] of enums) {
    if (!Object.hasOwn(input, key)) continue;
    if (!choices.includes(input[key])) throw invalid();
    if (input[key] !== defaultValue) theme[key] = input[key];
  }
  return theme;
}

/** A bounded allowlist on the existing token; null clears a timed override.
 * Persistent sources have no event timer and cannot acquire inert overrides.
 * @param {unknown} raw */
function validateOverlayProfile(raw) {
  if (!plain(raw)) throw invalid();
  const input = /** @type {Record<string,any>} */ (raw);
  if (input.v !== rules.version || Object.keys(input).some(key => !["v", "theme", "widgetOptions"].includes(key)) || !plain(input.widgetOptions)) throw invalid();
  const theme = validateProfileTheme(input.theme), widgetOptions = /** @type {Record<string,{durationSec:number|null}>} */ ({});
  const defaults = /** @type {Record<string,number|null>} */ (rules.widgetDurationMs);
  const entries = Object.entries(input.widgetOptions);
  if (entries.length > Object.keys(defaults).length) throw invalid();
  for (const [id, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!Object.hasOwn(defaults, id) || !plain(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "durationSec")) throw invalid();
    const seconds = value.durationSec;
    if (seconds !== null && (defaults[id] === null || !rules.durationSeconds.includes(seconds))) throw invalid();
    if (seconds !== null) widgetOptions[id] = { durationSec: seconds };
  }
  return { v: /** @type {1} */ (1), theme, widgetOptions };
}

/** Missing/corrupt old records use safe defaults without a migration.
 * @param {unknown} raw */
function overlayProfileForRead(raw) {
  try { return validateOverlayProfile(raw); } catch { return defaultOverlayProfile(); }
}
module.exports = { validateOverlayProfile, validateProfileTheme, defaultOverlayProfile, overlayProfileForRead };
