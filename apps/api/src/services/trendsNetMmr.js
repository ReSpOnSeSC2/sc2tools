"use strict";

/**
 * Net-MMR-by-matchup aggregation for the Trends tab.
 *
 * A delta belongs to the first game in a truly consecutive pair:
 * "next pre-game MMR - current pre-game MMR". Pairing therefore has
 * to happen before display filters are applied and must stay inside one
 * account, selected ladder race, and queue. Missing/unverified MMR rows
 * intentionally remain in the window so they break adjacency rather
 * than allowing the chart to jump over an unobserved game.
 */

const {
  myLadderRaceExpr,
  oppRaceSwitch,
} = require("./trendsRegionExpr");

/** A single ranked 1v1 result cannot credibly move more than this. */
const NET_MMR_MAX_DELTA = 150;

/**
 * @typedef {{
 *   games: import('mongodb').Collection,
 *   gamesMatchStage: (userId: string, filters: object) => object,
 *   bucketSwitch: () => object,
 * }} Deps
 */

/** @param {string} field */
function hasNonEmptyString(field) {
  return {
    $and: [
      { $eq: [{ $type: field }, "string"] },
      { $ne: [{ $trim: { input: field } }, ""] },
    ],
  };
}

/** @param {string} valueField @param {string} sourceField */
function isTrustedMmr(valueField, sourceField) {
  return {
    $and: [
      { $isNumber: valueField },
      { $eq: [sourceField, "replay"] },
    ],
  };
}

/** @param {Deps} deps @param {string} userId @param {object} filters */
async function netMmrByMatchup(deps, userId, filters) {
  const displayMatch = deps.gamesMatchStage(userId, filters);

  const [root = {}] = await deps.games
    .aggregate([
      // Window over complete per-user history. Applying opponent, map,
      // build, or date filters here would make non-consecutive rows look
      // consecutive and attribute their combined drift to one game.
      { $match: { userId } },
      {
        $addFields: {
          _bucket: deps.bucketSwitch(),
          _myLadderRace: myLadderRaceExpr(),
          _oppRace: oppRaceSwitch(),
          _hasMyAccount: hasNonEmptyString("$myToonHandle"),
          _hasMyMmr: { $isNumber: "$myMmr" },
          _trustedMyMmr: isTrustedMmr("$myMmr", "$myMmrSource"),
          _ranked1v1: {
            $and: [
              { $eq: ["$isLadderGame", true] },
              { $eq: ["$playerCount", 2] },
            ],
          },
        },
      },
      {
        $addFields: {
          // Queue fields remain in the partition even though only ranked
          // 1v1 is displayed, preventing custom/team replays from becoming
          // the next observation for a ladder game.
          _partitionKey: {
            account: { $ifNull: ["$myToonHandle", "__missing_account__"] },
            ladderRace: "$_myLadderRace",
            isLadder: { $ifNull: ["$isLadderGame", null] },
            playerCount: { $ifNull: ["$playerCount", null] },
          },
        },
      },
      {
        $setWindowFields: {
          partitionBy: "$_partitionKey",
          sortBy: { date: 1, gameId: 1 },
          output: {
            _nextGameId: {
              $shift: { output: "$gameId", by: 1, default: null },
            },
            _nextMyMmr: {
              $shift: { output: "$myMmr", by: 1, default: null },
            },
            _nextMyMmrSource: {
              $shift: { output: "$myMmrSource", by: 1, default: null },
            },
          },
        },
      },
      // Filters select CURRENT games. The next observation may sit outside
      // a date/opponent/map filter and still supplies the correct result of
      // the selected anchor game.
      { $match: displayMatch },
      {
        $addFields: {
          _hasNextMyMmr: { $isNumber: "$_nextMyMmr" },
          _trustedNextMyMmr: isTrustedMmr(
            "$_nextMyMmr",
            "$_nextMyMmrSource",
          ),
          _hasIdentity: {
            $and: [
              "$_hasMyAccount",
              { $in: ["$_myLadderRace", ["P", "T", "Z", "R"]] },
            ],
          },
        },
      },
      {
        $addFields: {
          _eligible: { $and: ["$_ranked1v1", "$_hasIdentity"] },
          _delta: {
            $cond: [
              { $and: ["$_trustedMyMmr", "$_trustedNextMyMmr"] },
              { $subtract: ["$_nextMyMmr", "$myMmr"] },
              null,
            ],
          },
        },
      },
      {
        $addFields: {
          _pairCandidate: {
            $and: [
              "$_eligible",
              "$_trustedMyMmr",
              "$_trustedNextMyMmr",
            ],
          },
          _withinDeltaCap: {
            $and: [
              { $gte: ["$_delta", -NET_MMR_MAX_DELTA] },
              { $lte: ["$_delta", NET_MMR_MAX_DELTA] },
            ],
          },
          // A win cannot lower, and a loss cannot raise, the MMR read from
          // the next consecutive replay. Violations signal missing/stale
          // data or ordering trouble, so do not misattribute them.
          _resultSignMatches: {
            $switch: {
              branches: [
                {
                  case: { $eq: ["$_bucket", "win"] },
                  then: { $gte: ["$_delta", 0] },
                },
                {
                  case: { $eq: ["$_bucket", "loss"] },
                  then: { $lte: ["$_delta", 0] },
                },
              ],
              default: false,
            },
          },
        },
      },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalGames: { $sum: 1 },
                eligibleGames: { $sum: { $cond: ["$_eligible", 1, 0] } },
                excludedNonRanked1v1: {
                  $sum: { $cond: ["$_ranked1v1", 0, 1] },
                },
                missingIdentity: {
                  $sum: {
                    $cond: [
                      { $and: ["$_ranked1v1", { $not: ["$_hasIdentity"] }] },
                      1,
                      0,
                    ],
                  },
                },
                missingMyMmr: {
                  $sum: {
                    $cond: [{ $not: ["$_hasMyMmr"] }, 1, 0],
                  },
                },
                untrustedMyMmr: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          "$_hasMyMmr",
                          { $not: ["$_trustedMyMmr"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                terminalGame: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          "$_eligible",
                          "$_trustedMyMmr",
                          { $eq: ["$_nextGameId", null] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                nextMissingMyMmr: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          "$_eligible",
                          "$_trustedMyMmr",
                          { $ne: ["$_nextGameId", null] },
                          { $not: ["$_hasNextMyMmr"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                nextUntrustedMyMmr: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          "$_eligible",
                          "$_trustedMyMmr",
                          "$_hasNextMyMmr",
                          { $not: ["$_trustedNextMyMmr"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                outlierSwing: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          "$_pairCandidate",
                          { $not: ["$_withinDeltaCap"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                signMismatch: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          "$_pairCandidate",
                          "$_withinDeltaCap",
                          { $in: ["$_bucket", ["win", "loss"]] },
                          { $not: ["$_resultSignMatches"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                unsupportedResult: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          "$_pairCandidate",
                          "$_withinDeltaCap",
                          { $not: [{ $in: ["$_bucket", ["win", "loss"]] }] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
          keptPairs: [
            {
              $match: {
                _pairCandidate: true,
                _withinDeltaCap: true,
                _resultSignMatches: true,
              },
            },
            {
              $group: {
                _id: "$_oppRace",
                netMmr: { $sum: "$_delta" },
                pairs: { $sum: 1 },
                wins: {
                  $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] },
                },
                losses: {
                  $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
                },
                avgDelta: { $avg: "$_delta" },
              },
            },
            { $sort: { netMmr: -1 } },
          ],
        },
      },
    ])
    .toArray();

  const summary = root.summary?.[0] || {};
  const keptPairs = /** @type {Array<Record<string, any>>} */ (
    root.keptPairs || []
  );
  const matchups = keptPairs.map((row) => {
    const pairs = row.pairs ?? row.games ?? 0;
    return {
      race: row._id,
      netMmr: Math.round(row.netMmr),
      avgDelta: Math.round(row.avgDelta * 10) / 10,
      pairs,
      // Keep the old wire key while clients roll forward.
      games: pairs,
      wins: row.wins,
      losses: row.losses,
      winRate: pairs ? row.wins / pairs : 0,
    };
  });

  return {
    matchups,
    totalGames: summary.totalGames || 0,
    eligibleGames: summary.eligibleGames || 0,
    dropped: {
      excludedNonRanked1v1: summary.excludedNonRanked1v1 || 0,
      missingIdentity: summary.missingIdentity || 0,
      missingMyMmr: summary.missingMyMmr || 0,
      untrustedMyMmr: summary.untrustedMyMmr || 0,
      terminalGame: summary.terminalGame || 0,
      nextMissingMyMmr: summary.nextMissingMyMmr || 0,
      nextUntrustedMyMmr: summary.nextUntrustedMyMmr || 0,
      outlierSwing: summary.outlierSwing || 0,
      signMismatch: summary.signMismatch || 0,
      unsupportedResult: summary.unsupportedResult || 0,
    },
  };
}

module.exports = {
  netMmrByMatchup,
  NET_MMR_MAX_DELTA,
};
