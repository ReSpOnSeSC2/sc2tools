"use strict";

/**
 * Ladder-map membership test.
 *
 * The live ladder pool (LadderMapPoolService) gives canonical map names
 * straight from Liquipedia — e.g. "Site Delta", "Goldenaura". A replay's
 * stored map name doesn't always match byte-for-byte: SC2 has shipped
 * names with a trailing " LE" (Ladder Edition) / " TE" (Team Edition)
 * tag, localized punctuation, and stray whitespace. Normalising both
 * sides to a lowercase alphanumeric key lets the comparison survive
 * those variations without a brittle exact-string match.
 */

/**
 * Reduce a map name to a comparison key: lowercase, drop the LE/TE
 * edition tags, strip everything that isn't a letter or digit.
 *
 * @param {unknown} name
 * @returns {string}
 */
function normalizeMapName(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/\b(?:le|te)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Build a Set of normalized keys from a pool of canonical map names.
 *
 * @param {string[]} pool
 * @returns {Set<string>}
 */
function buildLadderMapSet(pool) {
  const set = new Set();
  for (const m of Array.isArray(pool) ? pool : []) {
    const key = normalizeMapName(m);
    if (key) set.add(key);
  }
  return set;
}

/**
 * @param {unknown} mapName
 * @param {Set<string>} ladderSet
 * @returns {boolean}
 */
function isLadderMap(mapName, ladderSet) {
  if (!(ladderSet instanceof Set) || ladderSet.size === 0) return false;
  const key = normalizeMapName(mapName);
  return key.length > 0 && ladderSet.has(key);
}

module.exports = { normalizeMapName, buildLadderMapSet, isLadderMap };
