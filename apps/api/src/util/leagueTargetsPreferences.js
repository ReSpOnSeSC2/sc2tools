"use strict";

/**
 * ``preferences.leagueTargets`` — the Targets card's player choices:
 *
 *   leagueOverride  0..6 | null   compare against this league instead of the
 *                                 one read off the current MMR
 *   targetLeague    0..6 | null   season goal: reach this league
 *   targetMmr       1..8000 | null  season goal: reach this rating
 *
 * Reads fail soft to the defaults; writes reject anything malformed so a
 * bad client cannot replace saved choices.
 */

const LEAGUE_TARGETS_PREF_TYPE = "leagueTargets";
const KEYS = Object.freeze(["leagueOverride", "targetLeague", "targetMmr"]);
/** @typedef {{leagueOverride: number | null, targetLeague: number | null, targetMmr: number | null}} LeagueTargets */
/** @type {Readonly<LeagueTargets>} */
const DEFAULTS = Object.freeze({ leagueOverride: null, targetLeague: null, targetMmr: null });

/** @param {unknown} value @param {number} min @param {number} max */
function boundedInt(value, min, max) {
  return Number.isInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max;
}

/**
 * Example: `sanitizeLeagueTargets({ targetLeague: 5 })` →
 * `{ leagueOverride: null, targetLeague: 5, targetMmr: null }`.
 *
 * @param {unknown} raw
 * @param {boolean} [strict] throw on malformed input (writes)
 * @returns {LeagueTargets}
 */
function sanitizeLeagueTargets(raw, strict = false) {
  const fail = () => {
    if (strict) throw Object.assign(new Error("invalid_league_targets"), { status: 400, code: "invalid_league_targets" });
    return { ...DEFAULTS };
  };
  if (raw == null) return { ...DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) return fail();
  const input = /** @type {Record<string, unknown>} */ (raw);
  if (strict && Object.keys(input).some((key) => !KEYS.includes(key))) return fail();
  /** @type {LeagueTargets} */
  const out = { ...DEFAULTS };
  for (const key of ["leagueOverride", "targetLeague"]) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (!boundedInt(value, 0, 6)) return fail();
    /** @type {Record<string, number | null>} */ (out)[key] = /** @type {number} */ (value);
  }
  if (input.targetMmr !== undefined && input.targetMmr !== null) {
    if (!boundedInt(input.targetMmr, 1, 8000)) return fail();
    out.targetMmr = /** @type {number} */ (input.targetMmr);
  }
  return out;
}

module.exports = { LEAGUE_TARGETS_PREF_TYPE, sanitizeLeagueTargets };
