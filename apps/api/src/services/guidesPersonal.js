"use strict";

/**
 * The signed-in caller's own numbers for one build guide
 * (`GET /v1/guides/me/:matchup/:build`): their current-era games with the
 * build (same eligibility as the public aggregate) and the median
 * milestone times of their own guide_samples.
 *
 * Only the caller's data is ever read: games by their userId, samples by
 * their pseudonymous userHash (services/guideSamples.js userHash). The
 * route serves it `private, no-store`. No floor applies — it is the
 * user's own record — and nothing here is shared or cached.
 */

const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { milestonesForRace } = require("../config/guideMilestones");
const { PATCH_ERA_RULE, eraExpression } = require("../util/patchEra");
const { round4 } = require("../util/wilson");
const { guideGamesMatch } = require("./guideRules");

/** The caller's most recent samples considered for their medians. */
const ME_SAMPLES_MAX = 200;
const QUERY_MAX_MS = 10000;
const RESULT_VICTORY = "Victory";
const RESULT_DEFEAT = "Defeat";

/**
 * @typedef {object} GuideMePayload
 * @property {string} matchup
 * @property {string} buildKey
 * @property {string} era
 * @property {number} games
 * @property {number} wins
 * @property {number} losses
 * @property {number|null} winRate wins / decided, 4 dp; null with no decided game
 * @property {{ samples: number, milestones: Array<{ key: string, label: string,
 *   event: string, median: number, games: number }> }} timings
 */

/**
 * Median with linear interpolation (the same rule as the community
 * quantiles in services/guideStatsSamplePipelines.js).
 *
 * Example: `median([10, 20, 40])` → 20; `median([10, 20])` → 15.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) / 2;
  const lo = sorted[Math.floor(pos)];
  const hi = sorted[Math.ceil(pos)];
  return lo + (hi - lo) * (pos - Math.floor(pos));
}

/**
 * @param {import('mongodb').Collection} games
 * @param {string} userId
 * @param {string} matchup
 * @param {string} buildKey
 * @returns {Promise<{ games: number, wins: number, losses: number }>}
 */
async function myRecord(games, userId, matchup, buildKey) {
  const [row] = await games.aggregate([
    { $match: { ...guideGamesMatch(matchup), userId, myBuild: buildKey } },
    { $project: { _id: 0, result: 1, era: eraExpression() } },
    { $match: { era: GUIDE_CURRENT_ERA } },
    {
      $group: {
        _id: null,
        games: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$result", RESULT_VICTORY] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$result", RESULT_DEFEAT] }, 1, 0] } },
      },
    },
  ], { maxTimeMS: QUERY_MAX_MS }).toArray();
  return row ? { games: row.games, wins: row.wins, losses: row.losses } : { games: 0, wins: 0, losses: 0 };
}

/**
 * @param {import('mongodb').Collection} samples
 * @param {string} userHash
 * @param {string} matchup
 * @param {string} buildKey
 * @returns {Promise<GuideMePayload["timings"]>}
 */
async function myTimings(samples, userHash, matchup, buildKey) {
  const rows = await samples
    .find(
      { userHash, matchup, buildKey, era: GUIDE_CURRENT_ERA, eraRule: PATCH_ERA_RULE },
      { projection: { _id: 0, milestones: 1 }, maxTimeMS: QUERY_MAX_MS },
    )
    // Most recently PLAYED first (older rows without ``playedOn`` last, by
    // capture time); gameHash keeps equal days in a stable order.
    .sort({ playedOn: -1, createdAt: -1, gameHash: -1 })
    .limit(ME_SAMPLES_MAX)
    .toArray();
  const milestones = [];
  for (const milestone of milestonesForRace(matchup)) {
    const times = rows
      .map((row) => (row.milestones && typeof row.milestones === "object" ? row.milestones[milestone.key] : undefined))
      .filter((t) => typeof t === "number" && Number.isFinite(t));
    const mid = median(times);
    if (mid === null) continue;
    milestones.push({ key: milestone.key, label: milestone.label, event: milestone.event, median: mid, games: times.length });
  }
  return { samples: rows.length, milestones };
}

/**
 * The caller's own record and timings with one guide build.
 *
 * Example: `await personalGuideStats(db, { userId, userHash, matchup: "PvZ", buildKey })`
 * → `{ games: 37, wins: 18, losses: 19, winRate: 0.4865, timings: { … } }`.
 *
 * @param {{ games: import('mongodb').Collection, guideSamples: import('mongodb').Collection }} db
 * @param {{ userId: string, userHash: string, matchup: string, buildKey: string }} who
 * @returns {Promise<GuideMePayload>}
 */
async function personalGuideStats(db, who) {
  const [record, timings] = await Promise.all([
    myRecord(db.games, who.userId, who.matchup, who.buildKey),
    myTimings(db.guideSamples, who.userHash, who.matchup, who.buildKey),
  ]);
  const decided = record.wins + record.losses;
  return {
    matchup: who.matchup,
    buildKey: who.buildKey,
    era: GUIDE_CURRENT_ERA,
    games: record.games,
    wins: record.wins,
    losses: record.losses,
    winRate: decided > 0 ? round4(record.wins / decided) : null,
    timings,
  };
}

module.exports = { personalGuideStats, median, ME_SAMPLES_MAX };
