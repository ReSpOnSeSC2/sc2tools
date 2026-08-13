"use strict";

/**
 * Net-MMR-by-matchup aggregation for the Trends tab.
 *
 * A delta belongs to the first game in an adjacent stored-replay pair:
 * "next pre-game MMR - current pre-game MMR". Pairing therefore has
 * to happen before display filters are applied and must stay inside one
 * exact toon handle (account + server), selected ladder race, and queue.
 * Missing/unverified MMR rows
 * intentionally remain in the window so they break adjacency rather
 * than allowing the chart to jump over an observed gap. A replay that is
 * absent from storage cannot be detected here, so UI copy must not claim
 * that database adjacency proves uninterrupted Battle.net match history.
 */

const {
  regionFromToonHandleExpr,
  myLadderRaceExpr,
  oppRaceSwitch,
} = require("./trendsRegionExpr");

/** A single ranked 1v1 result cannot credibly move more than this. */
const NET_MMR_MAX_DELTA = 150;

/** Stable Battle.net region order shared with the MMR progression chart. */
const REGION_PRIORITY = ["NA", "EU", "KR", "CN", "SEA", "U"];

const DROP_REASON_KEYS = [
  "excludedNonRanked1v1",
  "missingIdentity",
  "missingMyMmr",
  "untrustedMyMmr",
  "terminalGame",
  "nextMissingMyMmr",
  "nextUntrustedMyMmr",
  "outlierSwing",
  "signMismatch",
  "unsupportedResult",
];

/**
 * @typedef {{
 *   games: import('mongodb').Collection,
 *   gamesMatchStage: (userId: string, filters: object) => object,
 *   bucketSwitch: () => object,
 *   pickTimezone: (raw: unknown) => string,
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

/**
 * Build the canonical accepted-pair input used by every net-MMR view.
 *
 * Keep this as the single source of truth for sequencing and rejection
 * rules. Race totals and opponent drill-downs must never independently
 * reimplement the window: even a small difference in where display
 * filters are applied would make the child rows fail to reconcile with
 * the clicked matchup bar.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @returns {Array<Record<string, any>>}
 */
function netMmrPairStages(deps, userId, filters) {
  const displayMatch = deps.gamesMatchStage(userId, filters);
  return [
    // Window over complete per-user history. Applying opponent, map,
    // build, or date filters here would make non-consecutive rows look
    // consecutive and attribute their combined drift to one game.
    { $match: { userId, isResumedFromReplay: { $ne: true } } },
    {
      $addFields: {
        _bucket: deps.bucketSwitch(),
        _myRegion: regionFromToonHandleExpr("$myToonHandle"),
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
      $addFields: {
        // Exactly one reason owns every filtered game that cannot produce
        // a measured delta. This makes coverage add up exactly instead of
        // double-counting an ineligible game in multiple diagnostics.
        _dropReason: {
          $switch: {
            branches: [
              {
                case: { $not: ["$_ranked1v1"] },
                then: "excludedNonRanked1v1",
              },
              {
                case: { $not: ["$_hasIdentity"] },
                then: "missingIdentity",
              },
              {
                case: { $not: ["$_hasMyMmr"] },
                then: "missingMyMmr",
              },
              {
                case: { $not: ["$_trustedMyMmr"] },
                then: "untrustedMyMmr",
              },
              {
                case: { $eq: ["$_nextGameId", null] },
                then: "terminalGame",
              },
              {
                case: { $not: ["$_hasNextMyMmr"] },
                then: "nextMissingMyMmr",
              },
              {
                case: { $not: ["$_trustedNextMyMmr"] },
                then: "nextUntrustedMyMmr",
              },
              {
                case: { $not: ["$_withinDeltaCap"] },
                then: "outlierSwing",
              },
              {
                case: { $not: [{ $in: ["$_bucket", ["win", "loss"]] }] },
                then: "unsupportedResult",
              },
              {
                case: { $not: ["$_resultSignMatches"] },
                then: "signMismatch",
              },
            ],
            default: null,
          },
        },
      },
    },
  ];
}

/** @param {unknown} groupId */
function coverageGroup(groupId) {
  /** @type {Record<string, any>} */
  const group = {
    _id: groupId,
    totalGames: { $sum: 1 },
    eligibleGames: { $sum: { $cond: ["$_eligible", 1, 0] } },
    measuredGames: {
      $sum: { $cond: [{ $eq: ["$_dropReason", null] }, 1, 0] },
    },
  };
  for (const reason of DROP_REASON_KEYS) {
    group[reason] = {
      $sum: { $cond: [{ $eq: ["$_dropReason", reason] }, 1, 0] },
    };
  }
  return group;
}

/** @param {Record<string, any>} [row] */
function droppedFromCoverage(row = {}) {
  return Object.fromEntries(
    DROP_REASON_KEYS.map((reason) => [reason, row[reason] || 0]),
  );
}

/**
 * @param {Record<string, any>} root
 * @param {string} timezone
 */
function dailySwingsFromFacet(root, timezone) {
  const totals = root.dailyTotals?.[0] || {};
  const normalizeSwing = (/** @type {Record<string, any> | undefined} */ row) => {
    if (!row || !row.day) return null;
    return {
      day: row.day,
      netMmr: Math.round(Number(row.netMmr) || 0),
      measuredGames: Math.max(0, Number(row.measuredGames) || 0),
      wins: Math.max(0, Number(row.wins) || 0),
      losses: Math.max(0, Number(row.losses) || 0),
    };
  };
  const regions = (Array.isArray(root.dailyByRegion)
    ? root.dailyByRegion
    : [])
    .map((row) => ({
      region: String(row.region || "U"),
      bestGain: normalizeSwing(
        row.bestGain && Number(row.bestGain.netMmr) > 0
          ? row.bestGain
          : undefined,
      ),
      biggestLoss: normalizeSwing(
        row.biggestLoss && Number(row.biggestLoss.netMmr) < 0
          ? row.biggestLoss
          : undefined,
      ),
      measuredDays: Math.max(0, Number(row.measuredDays) || 0),
      measuredGames: Math.max(0, Number(row.measuredGames) || 0),
    }))
    .sort((a, b) => {
      const ai = REGION_PRIORITY.indexOf(a.region);
      const bi = REGION_PRIORITY.indexOf(b.region);
      const aw = ai === -1 ? REGION_PRIORITY.length : ai;
      const bw = bi === -1 ? REGION_PRIORITY.length : bi;
      return aw - bw || a.region.localeCompare(b.region);
    });
  return {
    timezone,
    bestGain: normalizeSwing(root.dailyBestGain?.[0]),
    biggestLoss: normalizeSwing(root.dailyBiggestLoss?.[0]),
    measuredDays: Math.max(0, Number(totals.measuredDays) || 0),
    measuredGames: Math.max(0, Number(totals.measuredGames) || 0),
    regions,
  };
}

/** @param {string} timezone */
function dailyMmrGroupStage(timezone) {
  return {
    $group: {
      _id: { $dateTrunc: { date: "$date", unit: "day", timezone } },
      netMmr: { $sum: "$_delta" },
      measuredGames: { $sum: 1 },
      wins: {
        $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] },
      },
      losses: {
        $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
      },
    },
  };
}

function dailySwingProjectStage() {
  return {
    $project: {
      _id: 0,
      day: "$_id",
      netMmr: 1,
      measuredGames: 1,
      wins: 1,
      losses: 1,
    },
  };
}

/** @param {string} timezone */
function dailyByRegionGroupStage(timezone) {
  return {
    $group: {
      _id: {
        region: "$_myRegion",
        day: { $dateTrunc: { date: "$date", unit: "day", timezone } },
      },
      netMmr: { $sum: "$_delta" },
      measuredGames: { $sum: 1 },
      wins: {
        $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] },
      },
      losses: {
        $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
      },
    },
  };
}

function regionalSwingOutput() {
  return {
    day: "$_id.day",
    netMmr: "$netMmr",
    measuredGames: "$measuredGames",
    wins: "$wins",
    losses: "$losses",
  };
}

/**
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @param {{tz?: string}} [opts]
 */
async function netMmrByMatchup(deps, userId, filters, opts = {}) {
  const timezone = deps.pickTimezone(opts.tz);
  const [root = {}] = await deps.games
    .aggregate([
      ...netMmrPairStages(deps, userId, filters),
      {
        $facet: {
          summary: [{ $group: coverageGroup(null) }],
          coverage: [
            { $group: coverageGroup("$_oppRace") },
            { $sort: { _id: 1 } },
          ],
          keptPairs: [
            { $match: { _dropReason: null } },
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
          // Daily records reuse the exact accepted replay pairs above.
          // The delta belongs to the current (anchor) replay's local day;
          // the next replay may sit outside the active date filter and only
          // supplies that anchor game's ending MMR. Group across separately
          // partitioned accounts/races so the result is the user's total
          // movement on each selected day without ever cross-pairing ladders.
          dailyTotals: [
            { $match: { _dropReason: null } },
            dailyMmrGroupStage(timezone),
            {
              $group: {
                _id: null,
                measuredDays: { $sum: 1 },
                measuredGames: { $sum: "$measuredGames" },
              },
            },
            { $project: { _id: 0, measuredDays: 1, measuredGames: 1 } },
          ],
          dailyBestGain: [
            { $match: { _dropReason: null } },
            dailyMmrGroupStage(timezone),
            { $match: { netMmr: { $gt: 0 } } },
            // Deterministic ties: prefer the most recent local day.
            { $sort: { netMmr: -1, _id: -1 } },
            { $limit: 1 },
            dailySwingProjectStage(),
          ],
          dailyBiggestLoss: [
            { $match: { _dropReason: null } },
            dailyMmrGroupStage(timezone),
            { $match: { netMmr: { $lt: 0 } } },
            { $sort: { netMmr: 1, _id: -1 } },
            { $limit: 1 },
            dailySwingProjectStage(),
          ],
          // One bounded post-window branch derives both extrema for each
          // OWN ladder region. `$top` selects the latest day on equal net
          // movement, while the separate positive/negative counters let
          // response shaping turn an absent direction into null rather than
          // returning a flat/opposite-sign day.
          dailyByRegion: [
            { $match: { _dropReason: null } },
            dailyByRegionGroupStage(timezone),
            {
              $group: {
                _id: "$_id.region",
                bestGain: {
                  $top: {
                    sortBy: { netMmr: -1, "_id.day": -1 },
                    output: regionalSwingOutput(),
                  },
                },
                biggestLoss: {
                  $top: {
                    sortBy: { netMmr: 1, "_id.day": -1 },
                    output: regionalSwingOutput(),
                  },
                },
                positiveDays: {
                  $sum: { $cond: [{ $gt: ["$netMmr", 0] }, 1, 0] },
                },
                negativeDays: {
                  $sum: { $cond: [{ $lt: ["$netMmr", 0] }, 1, 0] },
                },
                measuredDays: { $sum: 1 },
                measuredGames: { $sum: "$measuredGames" },
              },
            },
            {
              $project: {
                _id: 0,
                region: "$_id",
                bestGain: {
                  $cond: [{ $gt: ["$positiveDays", 0] }, "$bestGain", null],
                },
                biggestLoss: {
                  $cond: [
                    { $gt: ["$negativeDays", 0] },
                    "$biggestLoss",
                    null,
                  ],
                },
                measuredDays: 1,
                measuredGames: 1,
              },
            },
          ],
        },
      },
    ])
    .toArray();

  const summary = root.summary?.[0] || {};
  const keptPairs = /** @type {Array<Record<string, any>>} */ (
    root.keptPairs || []
  );
  const coverage = /** @type {Array<Record<string, any>>} */ (
    root.coverage || []
  ).map((row) => ({
    race: row._id,
    totalGames: row.totalGames || 0,
    eligibleGames: row.eligibleGames || 0,
    measuredGames: row.measuredGames || 0,
    dropped: droppedFromCoverage(row),
  }));
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
    coverage,
    totalGames: summary.totalGames || 0,
    eligibleGames: summary.eligibleGames || 0,
    dropped: droppedFromCoverage(summary),
    dailySwings: dailySwingsFromFacet(root, timezone),
  };
}

module.exports = {
  netMmrByMatchup,
  netMmrPairStages,
  NET_MMR_MAX_DELTA,
};
