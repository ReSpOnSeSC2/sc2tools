"use strict";

/**
 * Helpers that decide *whether* and *with what* a game's
 * ``opponent.mmr`` may be back-stamped from SC2Pulse.
 *
 * Two rules, both learned the hard way (see the "6159 on 2018 games"
 * report):
 *
 *  1. RECENCY — a current / last-known ladder MMR is only a fair proxy
 *     for the opponent's MMR *at game time* on recent games. Beyond the
 *     trust window we refuse to stamp at all; the game stays "missing
 *     MMR" rather than wearing a rating it never had.
 *
 *  2. RACE — SC2Pulse tracks a *separate* MMR per race. A game where the
 *     opponent played Protoss must take their Protoss MMR, never their
 *     highest / most-recently-played race (which is how a Protoss game
 *     ended up tagged with the opponent's Terran rating). If we don't
 *     have a rating for the race they actually played, we stamp nothing.
 *
 * Pure functions — no DB, no network — so they're trivially testable and
 * shared by the per-game stamp (recordGame / refreshMetadata) and the
 * bulk backfill restamp.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trust horizon for treating current MMR as game-time MMR. Mirrors
 *  ``OPP_MMR_TRUST_MAX_AGE_DAYS`` on the read side (trendsOppMmr.js). */
const STAMP_MAX_AGE_DAYS = 365;

/** @param {number} [now] @returns {Date} */
function stampFloor(now = Date.now()) {
  return new Date(now - STAMP_MAX_AGE_DAYS * DAY_MS);
}

/**
 * Is ``playedAt`` recent enough that a current MMR is a fair proxy?
 * @param {Date|string|number|null|undefined} playedAt
 * @param {number} [now]
 * @returns {boolean}
 */
function isStampableDate(playedAt, now = Date.now()) {
  const t =
    playedAt instanceof Date
      ? playedAt.getTime()
      : typeof playedAt === "number"
        ? playedAt
        : Date.parse(String(playedAt));
  if (!Number.isFinite(t)) return false;
  return t >= now - STAMP_MAX_AGE_DAYS * DAY_MS;
}

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
 *  ``$regex: "^P"`` match against a mixed-spelling ``opponent.race``. */
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
  STAMP_MAX_AGE_DAYS,
  stampFloor,
  isStampableDate,
  canonicalRaceName,
  canonicalRaceLetter,
  pickRaceMmr,
};
