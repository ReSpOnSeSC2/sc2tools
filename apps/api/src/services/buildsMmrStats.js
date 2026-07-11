"use strict";

const { gamesMatchStage } = require("../util/parseQuery");
const {
  parseBucketWidth,
  bucketFor,
  bracketLabel,
  isBucketInRange,
  parseMmrDelta,
  MMR_FLOOR,
  MMR_CEILING,
} = require("../util/mmrBracketing");

/**
 * BuildsMmrStatsService — analytics keyed on MMR brackets.
 *
 * Powers the Builds / Strategies tabs' MMR-bracket charts:
 *   * ``buildWinRateByMmr``   — per myBuild, win rate at each MMR
 *                                bracket the streamer has played in.
 *   * ``oppStrategyWinRateByMmr`` — per opponent.strategy, win rate
 *                                at each opponent-MMR bracket.
 *   * ``buildVsStrategyByMmr`` — heatmap data: myBuild × oppStrategy
 *                                cells with a per-bracket breakdown.
 *   * ``buildAgingCurve``     — for each build, win rate as a
 *                                function of the Nth time the
 *                                streamer used it (the "learning
 *                                curve").
 *   * ``mmrProgressionByBuild`` — per myBuild, the streamer's
 *                                myMmr over time. Tells the user
 *                                whether each build is moving their
 *                                MMR forward, sideways, or back.
 *
 * Every method composes with the global filter set (date / race /
 * opponent race / map / region / MMR min-max / exclude-too-short)
 * via the shared ``gamesMatchStage`` helper, so the new charts
 * respect the FilterBar like every other tab.
 *
 * No-mock contract: every aggregation reads straight from the
 * ``games`` collection. Buckets that have no rows in the data
 * window simply don't appear in the response; the client renders
 * an empty chart rather than fabricated zero-rows.
 *
 * Bucket-width policy: callers pass ``opts.bucketWidth`` from the
 * URL (clamped via ``parseBucketWidth``). Same width is used for
 * grouping AND label generation so the response is self-describing.
 */
class BuildsMmrStatsService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Win rate per (myBuild, my-MMR bucket). One row per (build,
   * bucket) pair with usable data; rows the caller didn't ask
   * about (zero games) are absent rather than zero-filled — the
   * chart renders gaps natively.
   *
   * @param {string} userId
   * @param {object} filters
   * @param {{ bucketWidth?: unknown, mmrDelta?: unknown }} [opts] raw URL values; clamped by parseBucketWidth/parseMmrDelta
   * @returns {Promise<{
   *   bucketWidth: number,
   *   buckets: Array<{ build: string, bucket: number, label: string,
   *     wins: number, losses: number, games: number }>,
   * }>}
   */
  async buildWinRateByMmr(userId, filters, opts = {}) {
    const bucketWidth = parseBucketWidth(opts.bucketWidth);
    const mmrDelta = parseMmrDelta(opts.mmrDelta);
    const matchStage = this._mmrAwareMatch(userId, filters, mmrDelta);
    const rows = await this.db.games
      .aggregate([
        { $match: matchStage },
        {
          $addFields: {
            _bucket: this._bucketExpr("$myMmr", bucketWidth),
            _result: this._resultExpr(),
          },
        },
        {
          $match: {
            _bucket: { $ne: null },
            _result: { $in: ["win", "loss"] },
          },
        },
        {
          $group: {
            _id: {
              build: { $ifNull: ["$myBuild", "Unknown"] },
              bucket: "$_bucket",
            },
            wins: { $sum: { $cond: [{ $eq: ["$_result", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_result", "loss"] }, 1, 0] } },
            games: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            build: "$_id.build",
            bucket: "$_id.bucket",
            wins: 1,
            losses: 1,
            games: 1,
          },
        },
        { $sort: { build: 1, bucket: 1 } },
      ])
      .toArray();
    return {
      bucketWidth,
      buckets: this._enrichBuckets(rows, bucketWidth),
    };
  }

  /**
   * Win rate per (opponent.strategy, opponent-MMR bucket). Mirrors
   * ``buildWinRateByMmr`` but buckets on ``opponent.mmr`` and groups
   * by ``opponent.strategy``. Surfaces "what strategies do players
   * use at MMR X-Y" as a chart, exactly the climbing-curiosity
   * question the user described.
   *
   * @param {string} userId
   * @param {object} filters
   * @param {{ bucketWidth?: unknown, mmrDelta?: unknown }} [opts] raw URL values; clamped by parseBucketWidth/parseMmrDelta
   * @returns {Promise<{
   *   bucketWidth: number,
   *   buckets: Array<{ strategy: string, bucket: number, label: string,
   *     wins: number, losses: number, games: number }>,
   * }>}
   */
  async oppStrategyWinRateByMmr(userId, filters, opts = {}) {
    const bucketWidth = parseBucketWidth(opts.bucketWidth);
    const mmrDelta = parseMmrDelta(opts.mmrDelta);
    // Loose match: require myMmr but let the opponent-side mmr come
    // from either the per-game snapshot OR the opponents-collection
    // fallback (see _oppMmrLookupStages). Without this every game vs
    // an opponent the agent didn't tag with mmr — i.e. almost every
    // ranked 1v1 replay — would drop out of the chart.
    const matchStage = this._myMmrOnlyMatch(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: matchStage },
        ...this._oppMmrLookupStages(),
        {
          $match: this._oppMmrRangeMatch(mmrDelta),
        },
        {
          $addFields: {
            _bucket: this._bucketExpr("$_oppMmr", bucketWidth),
            _result: this._resultExpr(),
          },
        },
        {
          $match: {
            _bucket: { $ne: null },
            _result: { $in: ["win", "loss"] },
          },
        },
        {
          $group: {
            _id: {
              strategy: { $ifNull: ["$opponent.strategy", "Unknown"] },
              bucket: "$_bucket",
            },
            wins: { $sum: { $cond: [{ $eq: ["$_result", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_result", "loss"] }, 1, 0] } },
            games: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            strategy: "$_id.strategy",
            bucket: "$_id.bucket",
            wins: 1,
            losses: 1,
            games: 1,
          },
        },
        { $sort: { strategy: 1, bucket: 1 } },
      ])
      .toArray();
    const enriched = rows
      .filter((r) => isBucketInRange(r.bucket))
      .map((r) => ({
        strategy: r.strategy,
        bucket: r.bucket,
        label: bracketLabel(r.bucket, bucketWidth),
        wins: r.wins,
        losses: r.losses,
        games: r.games,
      }));
    return { bucketWidth, buckets: enriched };
  }

  /**
   * Build × opponent-strategy matchup, bucketed by MMR. Returns
   * tall rows so the client can pivot to whatever shape the
   * heatmap component wants (cell grid, sortable table, etc.)
   * without us having to commit to a single layout server-side.
   *
   * Bucket dimension is the average of ``myMmr`` and
   * ``opponent.mmr`` rounded to the nearest bucket — for a
   * matchup view the "game's MMR" is more meaningful than picking
   * either side arbitrarily. Both sides must be finite for the
   * row to participate (no half-data).
   *
   * @param {string} userId
   * @param {object} filters
   * @param {{ bucketWidth?: unknown, mmrDelta?: unknown }} [opts] raw URL values; clamped by parseBucketWidth/parseMmrDelta
   * @returns {Promise<{
   *   bucketWidth: number,
   *   cells: Array<{ build: string, strategy: string, bucket: number,
   *     label: string, wins: number, losses: number, games: number }>,
   * }>}
   */
  async buildVsStrategyByMmr(userId, filters, opts = {}) {
    const bucketWidth = parseBucketWidth(opts.bucketWidth);
    const mmrDelta = parseMmrDelta(opts.mmrDelta);
    // Same fallback as oppStrategyWinRateByMmr — the "match MMR"
    // average is just (myMmr + opp.mmr) / 2, and the opp side falls
    // back to the opponents-collection mmr when the per-game
    // snapshot is missing.
    const matchStage = this._myMmrOnlyMatch(userId, filters);
    const rows = await this.db.games
      .aggregate([
        { $match: matchStage },
        ...this._oppMmrLookupStages(),
        {
          $match: this._oppMmrRangeMatch(mmrDelta),
        },
        {
          $addFields: {
            _matchMmr: {
              $divide: [
                { $add: ["$myMmr", "$_oppMmr"] },
                2,
              ],
            },
            _result: this._resultExpr(),
          },
        },
        {
          $addFields: {
            _bucket: this._bucketExpr("$_matchMmr", bucketWidth),
          },
        },
        {
          $match: {
            _bucket: { $ne: null },
            _result: { $in: ["win", "loss"] },
          },
        },
        {
          $group: {
            _id: {
              build: { $ifNull: ["$myBuild", "Unknown"] },
              strategy: { $ifNull: ["$opponent.strategy", "Unknown"] },
              bucket: "$_bucket",
            },
            wins: { $sum: { $cond: [{ $eq: ["$_result", "win"] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $eq: ["$_result", "loss"] }, 1, 0] } },
            games: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            build: "$_id.build",
            strategy: "$_id.strategy",
            bucket: "$_id.bucket",
            wins: 1,
            losses: 1,
            games: 1,
          },
        },
        { $sort: { build: 1, strategy: 1, bucket: 1 } },
      ])
      .toArray();
    const cells = rows
      .filter((r) => isBucketInRange(r.bucket))
      .map((r) => ({
        build: r.build,
        strategy: r.strategy,
        bucket: r.bucket,
        label: bracketLabel(r.bucket, bucketWidth),
        wins: r.wins,
        losses: r.losses,
        games: r.games,
      }));
    return { bucketWidth, cells };
  }

  /**
   * "Build aging curve" — per-build win rate as a function of the
   * Nth time the streamer used the build (in chronological order).
   *
   * Why this isn't an MMR-bucketed view: the question is "have I
   * mastered this build" not "how good am I". Plotting WR vs game
   * count is the SC2-community-standard way to read learning
   * curves.
   *
   * Smoothed via cumulative wins/losses up to and including game N,
   * so the curve is stable rather than spiky. Clients can compute
   * a rolling window from the raw counts if they want a different
   * smoothing.
   *
   * @param {string} userId
   * @param {object} filters
   * @param {{ maxGames?: number, mmrDelta?: unknown }} [opts]
   * @returns {Promise<Array<{
   *   build: string,
   *   curve: Array<{ n: number, wins: number, losses: number,
   *     cumulativeWins: number, cumulativeLosses: number }>,
   * }>>}
   */
  async buildAgingCurve(userId, filters, opts = {}) {
    const mmrDelta = parseMmrDelta(opts.mmrDelta);
    const maxGames = clampPositiveInt(opts.maxGames, 500, 2000);
    const matchStage = this._mmrAwareMatch(userId, filters, mmrDelta);
    const rows = await this.db.games
      .aggregate([
        { $match: matchStage },
        { $addFields: { _result: this._resultExpr() } },
        { $match: { _result: { $in: ["win", "loss"] } } },
        { $sort: { date: 1 } },
        {
          $group: {
            _id: { $ifNull: ["$myBuild", "Unknown"] },
            games: {
              $push: {
                date: "$date",
                result: "$_result",
              },
            },
          },
        },
        { $project: { _id: 0, build: "$_id", games: 1 } },
        { $sort: { build: 1 } },
      ])
      .toArray();
    return rows.map((row) => {
      const curve = [];
      let cw = 0;
      let cl = 0;
      const games = row.games.slice(0, maxGames);
      for (let i = 0; i < games.length; i += 1) {
        const isWin = games[i].result === "win";
        if (isWin) cw += 1;
        else cl += 1;
        curve.push({
          n: i + 1,
          wins: isWin ? 1 : 0,
          losses: isWin ? 0 : 1,
          cumulativeWins: cw,
          cumulativeLosses: cl,
        });
      }
      return { build: row.build, curve };
    });
  }

  /**
   * "MMR progression by build" — for each build, the streamer's
   * own MMR at each game (date + myMmr) in chronological order.
   * Tells the user "when I used build X, where was my MMR" — the
   * climbing-correlation view.
   *
   * Returns one chronologically-sorted series per build. Charts
   * plot date on the x-axis and myMmr on the y-axis, one line per
   * build. Drops games without ``myMmr`` (no fake brackets).
   *
   * @param {string} userId
   * @param {object} filters
   * @param {{ maxPointsPerBuild?: number, mmrDelta?: unknown }} [opts]
   * @returns {Promise<Array<{
   *   build: string,
   *   points: Array<{ date: Date, mmr: number, result: 'win'|'loss' }>,
   * }>>}
   */
  async mmrProgressionByBuild(userId, filters, opts = {}) {
    const mmrDelta = parseMmrDelta(opts.mmrDelta);
    const maxPoints = clampPositiveInt(opts.maxPointsPerBuild, 500, 2000);
    const matchStage = this._mmrAwareMatch(userId, filters, mmrDelta);
    const rows = await this.db.games
      .aggregate([
        { $match: matchStage },
        { $addFields: { _result: this._resultExpr() } },
        { $match: { _result: { $in: ["win", "loss"] } } },
        { $sort: { date: 1 } },
        {
          $group: {
            _id: { $ifNull: ["$myBuild", "Unknown"] },
            points: {
              $push: {
                date: "$date",
                mmr: "$myMmr",
                result: "$_result",
              },
            },
          },
        },
        { $project: { _id: 0, build: "$_id", points: 1 } },
        { $sort: { build: 1 } },
      ])
      .toArray();
    return rows.map((row) => ({
      build: row.build,
      points: row.points.slice(0, maxPoints),
    }));
  }

  /**
   * Build the per-request $match stage. Composes:
   *   * The global filter set (date / race / map / region / MMR
   *     min-max / exclude-too-short).
   *   * Both-sides-have-MMR — no game with a missing ``myMmr`` or
   *     ``opponent.mmr`` participates in MMR-bucketed aggregates.
   *     Drops legacy data without fabricating brackets.
   *   * Plausibility floor / ceiling — drops corrupt or non-ladder
   *     rows so a single bad row can't stretch the x-axis to
   *     8000+ or push the chart underwater.
   *   * Optional mirror-MMR window — ``|myMmr - opponent.mmr| <=
   *     mmrDelta`` when the caller has narrowed the range. Default
   *     ``undefined`` means no filter.
   *
   * @private
   * @param {string} userId
   * @param {object} filters
   * @param {number|undefined} mmrDelta
   * @returns {Record<string, any>}
   */
  _mmrAwareMatch(userId, filters, mmrDelta) {
    const match = gamesMatchStage(userId, filters);
    match.myMmr = {
      $exists: true,
      $type: "number",
      $gte: MMR_FLOOR,
      $lte: MMR_CEILING,
    };
    match["opponent.mmr"] = {
      $exists: true,
      $type: "number",
      $gte: MMR_FLOOR,
      $lte: MMR_CEILING,
    };
    if (typeof mmrDelta === "number" && Number.isFinite(mmrDelta)) {
      match.$expr = {
        $lte: [
          { $abs: { $subtract: ["$myMmr", "$opponent.mmr"] } },
          mmrDelta,
        ],
      };
    }
    return match;
  }

  /**
   * Like ``_mmrAwareMatch`` but only enforces ``myMmr`` — leaves the
   * opponent-side MMR check to a downstream stage that consults the
   * opponents-collection fallback (see ``_oppMmrLookupStages``).
   * Used by the two opponent-MMR-bucketed pipelines so the AngryBird
   * scenario — a recent ranked game where sc2reader didn't carry
   * opp.mmr but SC2Pulse did — actually lands on the chart.
   *
   * @private
   * @param {string} userId
   * @param {object} filters
   * @returns {Record<string, any>}
   */
  _myMmrOnlyMatch(userId, filters) {
    const match = gamesMatchStage(userId, filters);
    match.myMmr = {
      $exists: true,
      $type: "number",
      $gte: MMR_FLOOR,
      $lte: MMR_CEILING,
    };
    return match;
  }

  /**
   * $lookup + $addFields stages that synthesise ``_oppMmr`` on each
   * input game: the per-game snapshot when numeric, otherwise the
   * opponent's latest MMR from the opponents collection (sourced
   * from SC2Pulse at ingest / by the backfill cron). Index-backed
   * via the unique ``{userId, pulseId}`` opponents index.
   *
   * @private
   * @returns {object[]}
   */
  _oppMmrLookupStages() {
    return [
      {
        $lookup: {
          from: "opponents",
          let: { uid: "$userId", pid: "$opponent.pulseId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$uid"] },
                    { $eq: ["$pulseId", "$$pid"] },
                  ],
                },
              },
            },
            { $project: { _id: 0, mmr: 1 } },
          ],
          as: "_opp",
        },
      },
      {
        $addFields: {
          _oppMmr: {
            $let: {
              vars: {
                snap: "$opponent.mmr",
                fallback: { $first: "$_opp.mmr" },
              },
              in: {
                $cond: [
                  { $isNumber: "$$snap" },
                  "$$snap",
                  {
                    $cond: [{ $isNumber: "$$fallback" }, "$$fallback", null],
                  },
                ],
              },
            },
          },
        },
      },
    ];
  }

  /**
   * $match stage applied AFTER ``_oppMmrLookupStages``: requires
   * ``_oppMmr`` in the plausible-MMR window and (optionally) within
   * ``mmrDelta`` of ``myMmr``. Mirror-MMR window uses ``_oppMmr`` so
   * a fallback value participates the same way as a snapshot.
   *
   * @private
   * @param {number|undefined} mmrDelta
   * @returns {Record<string, any>}
   */
  _oppMmrRangeMatch(mmrDelta) {
    /** @type {Record<string, any>} */
    const match = {
      _oppMmr: { $type: "number", $gte: MMR_FLOOR, $lte: MMR_CEILING },
    };
    if (typeof mmrDelta === "number" && Number.isFinite(mmrDelta)) {
      match.$expr = {
        $lte: [
          { $abs: { $subtract: ["$myMmr", "$_oppMmr"] } },
          mmrDelta,
        ],
      };
    }
    return match;
  }

  /**
   * Bucketing expression — ``floor(field / width) * width``. Picks
   * the bucket's lower bound, matching the JS ``bucketFor`` helper
   * so a number that round-trips matches the same bucket on both
   * sides.
   *
   * @private
   * @param {string} fieldPath
   * @param {number} width
   * @returns {Record<string, any>}
   */
  _bucketExpr(fieldPath, width) {
    return {
      $multiply: [
        { $floor: { $divide: [fieldPath, width] } },
        width,
      ],
    };
  }

  /**
   * Case-insensitive result classifier matching ``bucketSwitch`` in
   * BuildsService — accepts "Victory"/"Defeat"/"Win"/"Loss" so we
   * cover both the agent's modern payload and legacy snapshots.
   *
   * @private
   * @returns {Record<string, any>}
   */
  _resultExpr() {
    return {
      $switch: {
        branches: [
          {
            case: {
              $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "victory"],
            },
            then: "win",
          },
          {
            case: {
              $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "win"],
            },
            then: "win",
          },
          {
            case: {
              $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "defeat"],
            },
            then: "loss",
          },
          {
            case: {
              $eq: [{ $toLower: { $ifNull: ["$result", ""] } }, "loss"],
            },
            then: "loss",
          },
        ],
        default: null,
      },
    };
  }

  /**
   * Drop out-of-range buckets and stamp the human-readable label.
   * Shared by the two single-cut endpoints; the matchup endpoint
   * has the same logic inline because its row shape carries an
   * extra dimension.
   *
   * @private
   * @param {Array<any>} rows aggregation output rows, shaped
   *   ``{ build, bucket, wins, losses, games }`` by the $project
   *   stage upstream.
   * @param {number} bucketWidth
   */
  _enrichBuckets(rows, bucketWidth) {
    return rows
      .filter((r) => isBucketInRange(r.bucket))
      .map((r) => ({
        build: r.build,
        bucket: r.bucket,
        label: bracketLabel(r.bucket, bucketWidth),
        wins: r.wins,
        losses: r.losses,
        games: r.games,
      }));
  }
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function clampPositiveInt(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

module.exports = { BuildsMmrStatsService };
