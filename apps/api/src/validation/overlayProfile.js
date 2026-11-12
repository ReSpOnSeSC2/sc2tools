"use strict";
const rules = require("../../../web/lib/overlayProfileRules.json");
const { compositeWidgets } = require("../../../web/lib/overlayPresenceRules.json");
const LAYOUT_WIDGETS = new Set(compositeWidgets);
const PLACEMENT_KEYS = new Set(["anchor", "xPct", "yPct", "scale", "zIndex"]);
const LAYOUT_KEYS = /** @type {const} */ (["layout", "layoutVertical"]);
const THEME_KEYS = new Set(["accent", "scale", "opacity", "radius", "font", "style"]);
const plain = (/** @type {unknown} */ value) => !!value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => Object.assign(new Error("Use a valid overlay profile, theme, display time and widget placement."), { status: 400, code: "invalid_overlay_profile" });
/** Optional token preferences. Absence shows credit and leaves QR and voice off. */
const FLAG_KEYS = /** @type {const} */ (["credit", "creditQr", "ghostVoice"]);
const PROFILE_KEYS = new Set(["v", "theme", "widgetOptions", ...LAYOUT_KEYS, ...FLAG_KEYS]);
/** @typedef {{anchor:"top"|"bottom",xPct:number,yPct:number,scale:number,zIndex:number}} WidgetPlacement */
/** @typedef {Record<string,WidgetPlacement>} OverlayLayout */
/** @typedef {{v:1,theme:Record<string,any>,widgetOptions:Record<string,{durationSec:number|null}>,layout?:OverlayLayout,layoutVertical?:OverlayLayout,credit?:boolean,creditQr?:boolean,ghostVoice?:boolean}} OverlayProfile */
/** @returns {OverlayProfile} */
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

/** @param {unknown} value @param {number} min @param {number} max @returns {value is number} */
function inRange(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** @param {unknown} raw @returns {OverlayLayout} */
function validateLayout(raw) {
  if (!plain(raw)) throw invalid();
  const entries = Object.entries(/** @type {Record<string, any>} */ (raw));
  if (entries.length > LAYOUT_WIDGETS.size) throw invalid();
  /** @type {OverlayLayout} */
  const layout = {};
  for (const [id, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!LAYOUT_WIDGETS.has(id) || !plain(value) || Object.keys(value).some(key => !PLACEMENT_KEYS.has(key))) throw invalid();
    const { anchor, xPct, yPct, scale, zIndex = 0 } = value;
    if ((anchor !== "top" && anchor !== "bottom") || !inRange(xPct, 0, 100) || !inRange(yPct, 0, 100)
      || !inRange(scale, rules.layout.minScale, rules.layout.maxScale)
      || !Number.isInteger(zIndex) || !inRange(zIndex, 0, rules.layout.maxLayer)) throw invalid();
    layout[id] = { anchor, xPct, yPct, scale, zIndex };
  }
  return layout;
}

/** A bounded allowlist on the existing token; null clears a timed override.
 * Persistent sources have no event timer and cannot acquire inert overrides.
 * Credit, its QR code and Ghost voice are optional booleans.
 * @param {unknown} raw @returns {OverlayProfile} */
function validateOverlayProfile(raw) {
  if (!plain(raw)) throw invalid();
  const input = /** @type {Record<string,any>} */ (raw);
  if (input.v !== rules.version || Object.keys(input).some(key => !PROFILE_KEYS.has(key)) || !plain(input.widgetOptions)) throw invalid();
  if (FLAG_KEYS.some(key => Object.hasOwn(input, key) && typeof input[key] !== "boolean")) throw invalid();
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
  /** @type {OverlayProfile} */
  const profile = { v: /** @type {1} */ (1), theme, widgetOptions };
  for (const key of LAYOUT_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const layout = validateLayout(input[key]);
    if (Object.keys(layout).length) profile[key] = layout;
  }
  for (const key of FLAG_KEYS) if (Object.hasOwn(input, key)) profile[key] = input[key];
  return profile;
}

/** Missing/corrupt old records use safe defaults without a migration.
 * @param {unknown} raw */
function overlayProfileForRead(raw) {
  try { return validateOverlayProfile(raw); } catch { return defaultOverlayProfile(); }
}
module.exports = { validateOverlayProfile, validateProfileTheme, defaultOverlayProfile, overlayProfileForRead };
