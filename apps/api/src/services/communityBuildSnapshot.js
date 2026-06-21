"use strict";

/**
 * Helpers for turning a private custom-build doc into the public copy
 * stored in the community collection. Extracted from community.js so the
 * service file stays under the 800-line cap and the
 * what's-safe-to-publish whitelist lives in one obvious place.
 */

/**
 * Fields from a private custom-build doc that are safe to expose on the
 * public community copy. A whitelist (not a blacklist) so a newly-added
 * private field can never silently leak into the public snapshot:
 * anything not listed here is dropped. Notably absent — ``notes``
 * (personal scouting notes), ``sourceGameId`` (links to a private
 * replay), ``userId`` / ``_id`` (internal), and the share/visibility
 * flags (``isPublic`` / ``shareWithCommunity``).
 */
const PUBLIC_BUILD_FIELDS = Object.freeze([
  "slug",
  "name",
  "race",
  "vsRace",
  "matchup",
  "description",
  "signature",
  "rules",
  "schemaVersion",
  "skillLevel",
  "winConditions",
  "losesTo",
  "transitionsInto",
  "perspective",
  "steps",
]);

/**
 * Build the public snapshot stored under a community build's ``build``
 * field. See {@link PUBLIC_BUILD_FIELDS}.
 *
 * @param {Record<string, any>} priv
 * @returns {Record<string, any>}
 */
function publicBuildSnapshot(priv) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!priv || typeof priv !== "object") return out;
  for (const key of PUBLIC_BUILD_FIELDS) {
    if (priv[key] !== undefined) out[key] = priv[key];
  }
  return out;
}

/**
 * Derive a "PvT"-style matchup tag from a build's own race + target
 * race. v3 custom builds store ``race`` / ``vsRace`` rather than a
 * ``matchup`` string; without this the community listing's matchup
 * facet would be blank for every editor-authored build. Returns "" when
 * either side isn't a concrete race (e.g. vsRace "Any" or "Random"),
 * matching how the matchup filter treats unclassified rows.
 *
 * @param {string|undefined|null} race
 * @param {string|undefined|null} vsRace
 * @returns {string}
 */
function matchupFromRaces(race, vsRace) {
  const a = raceLetter(race);
  const b = raceLetter(vsRace);
  if (!a || !b) return "";
  return `${a}v${b}`;
}

/**
 * First letter of a concrete race (P/T/Z), or "" for
 * Random / Any / unknown — those don't define a matchup bucket.
 *
 * @param {string|undefined|null} race
 * @returns {string}
 */
function raceLetter(race) {
  if (typeof race !== "string") return "";
  const c = race.charAt(0).toUpperCase();
  return c === "P" || c === "T" || c === "Z" ? c : "";
}

module.exports = {
  PUBLIC_BUILD_FIELDS,
  publicBuildSnapshot,
  matchupFromRaces,
};
