"use strict";

/**
 * Pure shaping of the guide_samples-derived sections of a guide_stats
 * build doc: community milestone timings and army snapshots. Input rows
 * come from services/guideStatsPipelines.js, already floor-filtered and
 * with exact quantiles computed in Mongo; this module only applies the
 * display rules (presence threshold, winner/loser floor on both sides,
 * top-N units) and the catalog labels.
 */

const {
  GUIDE_MILESTONE_MIN_PRESENCE,
  GUIDE_ARMY_CHECKPOINTS_SEC,
  GUIDE_ARMY_TOP_UNITS,
} = require("../config/guides");
const { milestonesForRace } = require("../config/guideMilestones");
const { round4 } = require("../util/wilson");
const { meetsCellFloor } = require("./guideStatsShape");

/** @typedef {Record<string, any>} Row */

/**
 * @typedef {object} GuideMilestoneStat
 * @property {string} key
 * @property {string} label
 * @property {"start"|"finish"} event
 * @property {number} games
 * @property {number} users
 * @property {number} presence
 * @property {number} p25
 * @property {number} median
 * @property {number} p75
 * @property {{ games: number, users: number, median: number }} [winners]
 * @property {{ games: number, users: number, median: number }} [losers]
 */

/**
 * @typedef {object} GuideArmyCheckpoint
 * @property {number} samples samples carrying this checkpoint
 * @property {number} users
 * @property {Array<{ unit: string, presence: number, median: number, games: number }>} units
 */

/**
 * @param {number} part
 * @param {number} whole
 * @returns {number} part / whole, clamped to 1, 4 dp
 */
function shareOf(part, whole) {
  return round4(Math.min(1, part / whole));
}

/**
 * One side of a winner/loser split, or null below the floor.
 *
 * @param {unknown} games
 * @param {unknown} users
 * @param {unknown} median
 * @returns {{ games: number, users: number, median: number }|null}
 */
function splitSide(games, users, median) {
  if (typeof median !== "number" || !meetsCellFloor({ games, users })) return null;
  return { games: /** @type {number} */ (games), users: /** @type {number} */ (users), median };
}

/**
 * @param {Readonly<{ key: string, label: string, event: "start"|"finish" }>} milestone
 * @param {Row} row
 * @param {number} samples
 * @returns {GuideMilestoneStat}
 */
function milestoneStat(milestone, row, samples) {
  /** @type {GuideMilestoneStat} */
  const stat = {
    key: milestone.key,
    label: milestone.label,
    event: milestone.event,
    games: row.games,
    users: row.users,
    presence: shareOf(row.games, samples),
    p25: row.p25,
    median: row.median,
    p75: row.p75,
  };
  const winners = splitSide(row.winGames, row.winUsers, row.winMedian);
  const losers = splitSide(row.lossGames, row.lossUsers, row.lossMedian);
  if (winners && losers) {
    stat.winners = winners;
    stat.losers = losers;
  }
  return stat;
}

/**
 * Community timings of one build: catalog milestones (display order)
 * reached by at least GUIDE_MILESTONE_MIN_PRESENCE of the samples whose
 * games/users clear the floor.
 *
 * Example: `shapeTimings({ games: 80, users: 9 }, rows, "PvZ")` →
 * `{ samples: 80, users: 9, milestones: [{ key: "Pylon", median: 18, … }] }`.
 *
 * @param {Row|undefined} total ``{ games, users }`` samples of the build
 * @param {Row[]} rows milestone rows ``{ key, games, users, p25, median, p75, win*, loss* }``
 * @param {string} matchup "PvZ" form (the first letter picks the race catalog)
 * @returns {{ samples: number, users: number, milestones: GuideMilestoneStat[] }|null}
 */
function shapeTimings(total, rows, matchup) {
  if (!total || !meetsCellFloor(total)) return null;
  const byKey = new Map(rows.map((row) => [row.key, row]));
  /** @type {GuideMilestoneStat[]} */
  const milestones = [];
  for (const milestone of milestonesForRace(matchup)) {
    const row = byKey.get(milestone.key);
    if (!row || !meetsCellFloor(row) || typeof row.median !== "number") continue;
    if (row.games / total.games < GUIDE_MILESTONE_MIN_PRESENCE) continue;
    milestones.push(milestoneStat(milestone, row, total.games));
  }
  if (milestones.length === 0) return null;
  return { samples: total.games, users: total.users, milestones };
}

/**
 * @param {{ presence: number, median: number, unit: string }} a
 * @param {{ presence: number, median: number, unit: string }} b
 * @returns {number}
 */
function compareUnits(a, b) {
  if (b.presence !== a.presence) return b.presence - a.presence;
  if (b.median !== a.median) return b.median - a.median;
  return a.unit < b.unit ? -1 : 1;
}

/**
 * Army snapshots of one build at the 6/8/10-minute checkpoints. A
 * checkpoint appears when the samples carrying it clear the floor; a unit
 * when the samples fielding it do. ``presence`` = samples fielding the
 * unit / samples carrying the checkpoint; ``median`` = median count among
 * the samples that field it (missing ≠ zero).
 *
 * @param {Row[]} checkpointRows ``{ checkpoint, games, users }``
 * @param {Row[]} unitRows ``{ checkpoint, unit, games, users, median }``
 * @returns {Record<string, GuideArmyCheckpoint>|null}
 */
function shapeArmy(checkpointRows, unitRows) {
  /** @type {Record<string, GuideArmyCheckpoint>} */
  const army = {};
  for (const checkpoint of GUIDE_ARMY_CHECKPOINTS_SEC.map(String)) {
    const total = checkpointRows.find((row) => row.checkpoint === checkpoint);
    if (!total || !meetsCellFloor(total)) continue;
    const units = unitRows
      .filter((row) => row.checkpoint === checkpoint && meetsCellFloor(row) && typeof row.median === "number")
      .map((row) => ({
        unit: row.unit, presence: shareOf(row.games, total.games), median: row.median, games: row.games,
      }))
      .sort(compareUnits)
      .slice(0, GUIDE_ARMY_TOP_UNITS);
    if (units.length > 0) army[checkpoint] = { samples: total.games, users: total.users, units };
  }
  return Object.keys(army).length > 0 ? army : null;
}

module.exports = { shapeTimings, shapeArmy };
