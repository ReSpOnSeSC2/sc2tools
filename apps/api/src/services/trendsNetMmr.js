"use strict";

/**
 * Net-MMR-by-matchup aggregation for the Trends tab. Carved out of
 * ``trendsInsights.js`` to keep that file within the per-file size
 * budget. Same ``deps`` contract as its siblings — ``{ games,
 * gamesMatchStage, bucketSwitch }``.
 *
 * @typedef {{
 *   games: import('mongodb').Collection,
 *   gamesMatchStage: (userId: string, filters: object) => object,
 *   bucketSwitch: () => object,
 * }} Deps
 */

const {
  regionFromToonHandleExpr,
  oppRaceSwitch,
} = require("./trendsRegionExpr");

/**
 * Hard cap on the per-game pre-match → pre-match delta we trust as
 * attributable to ONE matchup. A real SC2 1v1 swing tops out around
 * ±60 MMR; anything past ±150 is almost certainly a race switch into
 * a different ladder (Protoss main dipping into Random),
 * a season soft-reset, or a stretch of unrecorded games inflating
 * the diff. Region partitioning + this cap together are now the
 * only outlier guards — the older 24 h "session" cap was dropped
 * once we had region partitioning + the dashboard's SC2Pulse-backed
 * current-MMR card reconciling the totals, since pair gaps within a
 * region almost always reflect a real ladder break rather than
 * unrecorded games.
 */
const NET_MMR_MAX_DELTA = 150;

/**
 * Net MMR change per opponent race. The simple model:
 *   "running tally of MMR won or lost per matchup, per region."
 *
 * For every consecutive pair of MMR-tagged games on the SAME REGION,
 * attribute the delta (next.myMmr − this.myMmr) to the opponent race
 * of the FIRST game. The region partition is the important part —
 * a streamer who plays both NA (4900 MMR) and EU (3500 MMR) would
 * otherwise see a phantom −1400 attributed to whichever matchup
 * happened to bridge the region switch.
 *
 * Region is derived from ``myToonHandle``'s leading byte
 * (1=NA, 2=EU, 3=KR, 5=CN, 6=SEA — see ``regionFromToonHandle``).
 * Games without a ``myToonHandle`` (older agent versions) land in a
 * shared "Unknown" partition where the ``NET_MMR_MAX_DELTA`` cap
 * still drops the worst cross-region noise.
 *
 * One guard keeps the chart honest:
 *
 *   |delta| ≤ ``NET_MMR_MAX_DELTA``. Single-game ladder swings
 *   max out near ±60. Anything past 150 is a race-pool switch, a
 *   season reset, or a recording gap — never a single match.
 *
 * The older 24 h gap cap is gone: with region partitioning in
 * place and the dashboard's SC2Pulse-backed current-MMR card
 * reconciling the running totals, pair gaps within a region almost
 * always reflect a real ladder break rather than unrecorded games —
 * the user explicitly asked for those pairs to count.
 *
 * The summary carries ``totalGames`` (size of the filtered set)
 * plus ``dropped.missingMyMmr`` (games in the filter that don't
 * carry myMmr at all — older agent versions, missing
 * scaled_rating) and ``dropped.outlierSwing`` (pairs nuked by the
 * delta cap). Without those, users compare the pair count to the
 * Win-Rate-by-MMR game count and assume the chart is broken.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 */
async function netMmrByMatchup(deps, userId, filters) {
  const match = deps.gamesMatchStage(userId, filters);
  // Shared pairing prefix used by the keptPairs + droppedPairs
  // facet branches. Inlined here (rather than nested $facet) because
  // MongoDB disallows $facet inside $facet — the duplication is the
  // price of getting summary + kept + dropped from one aggregate.
  const pairingPrefix = [
    { $match: { _hasMyMmr: true } },
    {
      $addFields: {
        _bucket: deps.bucketSwitch(),
        _myRegion: regionFromToonHandleExpr("$myToonHandle"),
      },
    },
    {
      $setWindowFields: {
        partitionBy: "$_myRegion",
        sortBy: { date: 1 },
        output: {
          _nextMyMmr: { $shift: { output: "$myMmr", by: 1, default: null } },
        },
      },
    },
    { $match: { _nextMyMmr: { $type: "number" } } },
    {
      $addFields: {
        _delta: { $subtract: ["$_nextMyMmr", "$myMmr"] },
        _oppRace: oppRaceSwitch(),
      },
    },
  ];
  const facet = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _hasMyMmr: { $isNumber: "$myMmr" } } },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalGames: { $sum: 1 },
                missingMyMmr: { $sum: { $cond: ["$_hasMyMmr", 0, 1] } },
              },
            },
          ],
          keptPairs: [
            ...pairingPrefix,
            {
              $match: {
                _delta: { $gte: -NET_MMR_MAX_DELTA, $lte: NET_MMR_MAX_DELTA },
              },
            },
            {
              $group: {
                _id: "$_oppRace",
                netMmr: { $sum: "$_delta" },
                games: { $sum: 1 },
                wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
                losses: {
                  $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] },
                },
                avgDelta: { $avg: "$_delta" },
              },
            },
            { $sort: { netMmr: -1 } },
          ],
          droppedPairs: [
            ...pairingPrefix,
            {
              $group: {
                _id: null,
                outlierSwing: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $lt: ["$_delta", -NET_MMR_MAX_DELTA] },
                          { $gt: ["$_delta", NET_MMR_MAX_DELTA] },
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
        },
      },
    ])
    .toArray();
  const root = facet[0] || {};
  const summaryRow = (root.summary && root.summary[0]) || null;
  const keptRows = root.keptPairs || [];
  const droppedRow = (root.droppedPairs && root.droppedPairs[0]) || null;
  return {
    matchups: keptRows.map((r) => ({
      race: r._id,
      netMmr: Math.round(r.netMmr),
      avgDelta: Math.round(r.avgDelta * 10) / 10,
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      winRate: r.games ? r.wins / r.games : 0,
    })),
    totalGames: summaryRow ? summaryRow.totalGames : 0,
    dropped: {
      outlierSwing: droppedRow ? droppedRow.outlierSwing : 0,
      missingMyMmr: summaryRow ? summaryRow.missingMyMmr : 0,
    },
  };
}

module.exports = {
  netMmrByMatchup,
  NET_MMR_MAX_DELTA,
};
