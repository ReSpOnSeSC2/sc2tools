"use strict";

/**
 * Account appearance and region preferences (Settings → Preferences →
 * Appearance): text size, density, language and region for dates and
 * numbers, the clock and the first day of the week. Mirrors
 * apps/web/lib/appearance.ts.
 *
 * Reads are tolerant (unknown or malformed fields become defaults, so an
 * account that never saved gets the defaults); writes are strict.
 */
const APPEARANCE_PREF_TYPE = "appearance";
const CHOICES = Object.freeze({
  textSize: ["100", "112.5", "125"],
  density: ["comfortable", "compact"],
  hourCycle: ["auto", "h12", "h23"],
  weekStart: ["auto", "monday", "sunday", "saturday"],
});
const DEFAULTS = Object.freeze({ textSize: "100", density: "comfortable", locale: "auto", hourCycle: "auto", weekStart: "auto" });
const KEYS = Object.freeze(/** @type {Array<keyof typeof DEFAULTS>} */ (Object.keys(DEFAULTS)));
const MAX_LOCALE_LENGTH = 35;

/** @param {unknown} raw @returns {string | null} */
function canonicalLocale(raw) {
  if (typeof raw !== "string" || !raw || raw.length > MAX_LOCALE_LENGTH) return null;
  try {
    const [tag] = Intl.getCanonicalLocales(raw);
    return tag && tag.length <= MAX_LOCALE_LENGTH ? tag : null;
  } catch {
    return null;
  }
}

const invalid = () => Object.assign(new Error("Choose a valid text size, density, language and region, clock and week start."), { status: 400, code: "invalid_appearance" });

/**
 * @param {unknown} raw
 * @param {boolean} [strict] reject unknown keys and invalid values (writes)
 * @returns {{textSize:string,density:string,locale:string,hourCycle:string,weekStart:string}}
 */
function sanitizeAppearance(raw, strict = false) {
  const object = !!raw && typeof raw === "object" && !Array.isArray(raw);
  if (strict && (!object || Object.keys(/** @type {object} */ (raw)).some(key => !KEYS.includes(/** @type {any} */ (key))))) throw invalid();
  const value = /** @type {Record<string, unknown>} */ (object ? raw : {});
  const out = { ...DEFAULTS };
  for (const key of /** @type {Array<keyof typeof CHOICES>} */ (Object.keys(CHOICES))) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === "string" && CHOICES[key].includes(/** @type {string} */ (value[key]))) out[key] = /** @type {any} */ (value[key]);
    else if (strict) throw invalid();
  }
  if (value.locale !== undefined) {
    const locale = value.locale === "auto" ? "auto" : canonicalLocale(value.locale);
    if (locale) out.locale = locale;
    else if (strict) throw invalid();
  }
  return out;
}

module.exports = { APPEARANCE_PREF_TYPE, APPEARANCE_DEFAULTS: DEFAULTS, sanitizeAppearance };
