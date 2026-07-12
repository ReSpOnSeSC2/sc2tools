"use strict";

/**
 * Race-normalisation helpers shared by game-level MMR consumers.
 * SC2Pulse tracks a separate rating per race, so a Protoss game must
 * never borrow the opponent's higher Terran rating. The forward-only
 * enrichment job owns recency and range policy; these pure helpers own
 * only race identity and matching.
 */

/** @type {Record<string, "Protoss"|"Terran"|"Zerg"|"Random">} */
const RACE_NAMES = { P: "Protoss", T: "Terran", Z: "Zerg", R: "Random" };

/**
 * Normalise any race spelling (``"P"`` / ``"protoss"`` / ``"Protoss"`` /
 * ``"PROTOSS"``) to the canonical full name SC2Pulse uses, or null when
 * the input isn't a recognisable race (e.g. ``"U"`` / unknown).
 * @param {unknown} raw
 * @returns {"Protoss"|"Terran"|"Zerg"|"Random"|null}
 */
function canonicalRaceName(raw) {
  if (typeof raw !== "string" || !raw) return null;
  const c = raw.trim().charAt(0).toUpperCase();
  return RACE_NAMES[c] || null;
}

/** First letter of the canonical race name, or null. Handy for a Mongo
 *  ``$regex: "^P"`` match against a mixed-spelling ``opponent.race``.
 *  @param {unknown} raw
 *  @returns {string|null} */
function canonicalRaceLetter(raw) {
  const name = canonicalRaceName(raw);
  return name ? name.charAt(0) : null;
}

/**
 * From a SC2Pulse per-race breakdown (``[{race, mmr, region}, ...]``),
 * pick the entry matching ``race``. Returns ``{ mmr, region }`` (mmr
 * rounded, > 0) or null when there's no team for that race.
 * @param {Array<{race?: string, mmr?: number, region?: string|null}>} races
 * @param {unknown} race
 * @returns {{ mmr: number, region: string|null }|null}
 */
function pickRaceMmr(races, race) {
  const want = canonicalRaceName(race);
  if (!want || !Array.isArray(races)) return null;
  for (const r of races) {
    if (canonicalRaceName(r && r.race) !== want) continue;
    const mmr = Number(r && r.mmr);
    if (Number.isFinite(mmr) && mmr > 0) {
      return {
        mmr: Math.round(mmr),
        region: typeof r.region === "string" ? r.region : null,
      };
    }
  }
  return null;
}

module.exports = {
  canonicalRaceName,
  canonicalRaceLetter,
  pickRaceMmr,
};
