"use strict";

/**
 * Ladder league bands shared by the Replay Review Exchange.
 *
 * Ids follow Blizzard's ladder ``leagueId`` numbering (0 Bronze … 6
 * Grandmaster) — the same numbering ``opponent.leagueId`` on slim game
 * rows and the Ladder Meta Radar use — so a band read off an MMR and a
 * band read off a Pulse league id compare directly.
 *
 * The MMR → league floors are the league boundaries of
 * ``overlayLive.leagueFromMmr`` (Blizzard's approximate published
 * cutoffs). They are a banding convention, not a claim about any one
 * season's exact ladder: reviews only need "is this reviewer Diamond
 * or Masters", and a few hundred MMR of seasonal drift inside a tier
 * does not change that answer.
 */

const LEAGUES = Object.freeze([
  Object.freeze({ id: 0, key: "bronze", label: "Bronze", minMmr: 0 }),
  Object.freeze({ id: 1, key: "silver", label: "Silver", minMmr: 900 }),
  Object.freeze({ id: 2, key: "gold", label: "Gold", minMmr: 1800 }),
  Object.freeze({ id: 3, key: "platinum", label: "Platinum", minMmr: 2700 }),
  Object.freeze({ id: 4, key: "diamond", label: "Diamond", minMmr: 3600 }),
  Object.freeze({ id: 5, key: "master", label: "Master", minMmr: 4600 }),
  Object.freeze({ id: 6, key: "grandmaster", label: "Grandmaster", minMmr: 6500 }),
]);

const MASTERS_BAND_ID = 5;
/** Anything outside this range is non-ladder noise or a corrupt row. */
const MIN_PLAUSIBLE_MMR = 1;
const MAX_PLAUSIBLE_MMR = 8000;

/**
 * @param {unknown} mmr
 * @returns {boolean}
 */
function isPlausibleMmr(mmr) {
  return typeof mmr === "number"
    && Number.isFinite(mmr)
    && mmr >= MIN_PLAUSIBLE_MMR
    && mmr <= MAX_PLAUSIBLE_MMR;
}

/**
 * @param {unknown} mmr
 * @returns {{id: number, key: string, label: string} | null}
 */
function bandFromMmr(mmr) {
  if (!isPlausibleMmr(mmr)) return null;
  const value = /** @type {number} */ (mmr);
  let match = LEAGUES[0];
  for (const league of LEAGUES) {
    if (value >= league.minMmr) match = league;
  }
  return { id: match.id, key: match.key, label: match.label };
}

/**
 * @param {unknown} id
 * @returns {{id: number, key: string, label: string} | null}
 */
function bandFromId(id) {
  const n = typeof id === "number" ? id : Number.parseInt(String(id ?? ""), 10);
  const league = LEAGUES.find((l) => l.id === n);
  return league ? { id: league.id, key: league.key, label: league.label } : null;
}

/**
 * Coarse MMR for public display ("~4,100 MMR"). Rounded to the nearest
 * 100 so a public page can never be used to pin down an exact rating —
 * and therefore an exact ladder account.
 *
 * @param {unknown} mmr
 * @returns {number | null}
 */
function approximateMmr(mmr) {
  if (!isPlausibleMmr(mmr)) return null;
  return Math.round(/** @type {number} */ (mmr) / 100) * 100;
}

/**
 * @param {number | null} mmr
 * @returns {string}
 */
function formatApproxMmr(mmr) {
  if (mmr === null) return "";
  return `~${mmr.toLocaleString("en-US")} MMR`;
}

module.exports = {
  LEAGUES,
  MASTERS_BAND_ID,
  isPlausibleMmr,
  bandFromMmr,
  bandFromId,
  approximateMmr,
  formatApproxMmr,
};
