"use strict";

/**
 * Trends-tab "Player Insight" aggregations.
 *
 * Carved off from ``trendsAggregations.js`` so the deeper-signal
 * charts added in v0.5.x (MMR progression, tilt/momentum, skill
 * spread, build/strategy mix, map trends, net-MMR-by-matchup) stay
 * separate from the original basic time-series helpers. Same
 * ``deps`` contract as its sibling — ``{ games, gamesMatchStage,
 * bucketSwitch, pickInterval, pickTimezone }`` — so call sites in
 * ``AggregationsService`` remain one-liners.
 *
 * Pipelines lean on ``$setWindowFields`` / ``$shift`` (Mongo 5.0+,
 * available on the production driver pinned to mongodb@6.13). They
 * never reach into the heavy ``game_details`` blob: every signal is
 * derived from the slim ``games`` row alone.
 */

const { LIMITS } = require("../config/constants");

const RESULT_VICTORY = ["victory", "win"];
const RESULT_DEFEAT = ["defeat", "loss"];

/** Default gap that separates one ladder session from the next. */
const SESSION_GAP_MINUTES = 90;
/** Cap the within-session position bins — beyond this it's noise. */
const MAX_SESSION_POSITIONS = 12;
/** Bucket widths offered by the opponent-MMR histogram. */
const OPP_MMR_BUCKET_WIDTHS = [50, 100];
/** Range threshold (in MMR) below which 50-wide bins read cleaner. */
const OPP_MMR_AUTO_WIDTH_CUTOFF = 500;
/** Safety cap so a malformed payload can't fan out to thousands of bins. */
const OPP_MMR_MAX_BUCKETS = 80;

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
 * @typedef {{
 *   games: import('mongodb').Collection,
 *   gamesMatchStage: (userId: string, filters: object) => object,
 *   bucketSwitch: () => object,
 *   pickInterval: (raw: unknown) => 'day' | 'week' | 'month',
 *   pickTimezone: (raw: unknown) => string,
 * }} Deps
 */

/**
 * MMR progression over time. One point per bucket (day/week/month),
 * with the closing MMR (the most recent valid myMmr in the bucket)
 * plus min/max so the client can paint a band when bucket size
 * collapses several games into one mark.
 *
 * The response also carries a ``regions`` array — one entry per
 * Battle.net region the user has actually played on (NA, EU, KR, CN,
 * SEA, plus "U" for older agent versions whose toon handle wasn't
 * recorded). Each region carries its own points + peak/trough/latest
 * so the client can paint one line per ladder; without the split, a
 * 5,000-MMR NA main who dabbles on a 3,500-MMR EU smurf saw the
 * combined line dive whenever they queued EU. Region is derived
 * from ``myToonHandle`` via {@link regionFromToonHandleExpr} — the
 * same source of truth the netMmrByMatchup pipeline uses.
 *
 * The overall ``points`` / ``peak`` / ``trough`` / ``latest`` scalars
 * are preserved at the top level so existing consumers keep working
 * even if they ignore the new ``regions`` field.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
 * @param {object} filters
 */
async function mmrProgression(deps, userId, opts, filters) {
  const interval = deps.pickInterval(opts && opts.interval);
  const timezone = deps.pickTimezone(opts && opts.tz);
  const match = deps.gamesMatchStage(userId, filters);
  const truncBucket = {
    $dateTrunc: { date: "$date", unit: interval, timezone },
  };
  const projectPoint = {
    _id: 0,
    bucket: "$_id",
    openMmr: 1,
    closeMmr: 1,
    minMmr: 1,
    maxMmr: 1,
    wins: 1,
    losses: 1,
    total: 1,
  };
  const groupAccumulators = {
    // $last after $sort:asc gives the most recent MMR in the bucket.
    closeMmr: { $last: "$myMmr" },
    openMmr: { $first: "$myMmr" },
    minMmr: { $min: "$myMmr" },
    maxMmr: { $max: "$myMmr" },
    wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
    losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
    total: { $sum: 1 },
  };
  const facet = await deps.games
    .aggregate([
      { $match: { ...match, myMmr: { $type: "number" } } },
      {
        $addFields: {
          _bucket: deps.bucketSwitch(),
          _myRegion: regionFromToonHandleExpr("$myToonHandle"),
        },
      },
      // Sort once before $facet so both sub-pipelines see the same
      // chronological order and $first / $last resolve to the
      // bucket's opening / closing MMR.
      { $sort: { date: 1 } },
      {
        $facet: {
          overall: [
            { $group: { _id: truncBucket, ...groupAccumulators } },
            { $sort: { _id: -1 } },
            { $limit: LIMITS.TIMESERIES_MAX_BUCKETS },
            { $sort: { _id: 1 } },
            { $project: projectPoint },
          ],
          byRegion: [
            {
              $group: {
                _id: { bucket: truncBucket, region: "$_myRegion" },
                ...groupAccumulators,
              },
            },
            // Cap with the same single-region budget × the five real
            // regions + one "U" bin; for a single-region account this
            // is identical to the overall cap.
            { $sort: { "_id.bucket": -1 } },
            { $limit: LIMITS.TIMESERIES_MAX_BUCKETS * 6 },
            { $sort: { "_id.region": 1, "_id.bucket": 1 } },
            {
              $project: {
                _id: 0,
                bucket: "$_id.bucket",
                region: "$_id.region",
                openMmr: 1,
                closeMmr: 1,
                minMmr: 1,
                maxMmr: 1,
                wins: 1,
                losses: 1,
                total: 1,
              },
            },
          ],
        },
      },
    ])
    .toArray();
  const root = facet[0] || { overall: [], byRegion: [] };
  const overall = Array.isArray(root.overall) ? root.overall : [];
  const regions = groupRegionSeries(
    Array.isArray(root.byRegion) ? root.byRegion : [],
  );
  return { interval, points: overall, regions, ...summarize(overall) };
}

/**
 * Bucket the flat per-(bucket, region) rows from the byRegion facet
 * into one series per region, attaching per-region peak/trough/latest
 * so the client can drop them into the headline without scanning the
 * series itself. Region order matches REGION_PRIORITY so the legend
 * is stable across reloads regardless of how the user toggled the
 * region filter.
 *
 * @param {Array<{bucket: Date, region: string} & Record<string, number>>} rows
 */
function groupRegionSeries(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = r.region || "U";
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
    }
    bucket.push({
      bucket: r.bucket,
      openMmr: r.openMmr,
      closeMmr: r.closeMmr,
      minMmr: r.minMmr,
      maxMmr: r.maxMmr,
      wins: r.wins,
      losses: r.losses,
      total: r.total,
    });
  }
  const ordered = [];
  for (const region of REGION_PRIORITY) {
    if (byKey.has(region)) {
      ordered.push({ region, points: byKey.get(region), ...summarize(byKey.get(region)) });
      byKey.delete(region);
    }
  }
  // Any unexpected region label (future Blizzard cluster, malformed
  // toon handle) gets appended after the known set in alphabetical
  // order so it still shows up rather than being silently dropped.
  for (const region of Array.from(byKey.keys()).sort()) {
    ordered.push({ region, points: byKey.get(region), ...summarize(byKey.get(region)) });
  }
  return ordered;
}

/**
 * Ordering used for the per-region series. Matches the FilterBar
 * toggle order so the chart legend reads in the same direction the
 * user picks regions in the filter row.
 */
const REGION_PRIORITY = ["NA", "EU", "KR", "CN", "SEA", "U"];

/** @param {Array<{closeMmr: number, minMmr: number, maxMmr: number, bucket: Date}>} rows */
function summarize(rows) {
  if (!rows || rows.length === 0) {
    return { peak: null, trough: null, latest: null };
  }
  let peak = rows[0];
  let trough = rows[0];
  for (const r of rows) {
    if (r.maxMmr > peak.maxMmr) peak = r;
    if (r.minMmr < trough.minMmr) trough = r;
  }
  return {
    peak: { bucket: peak.bucket, mmr: peak.maxMmr },
    trough: { bucket: trough.bucket, mmr: trough.minMmr },
    latest: {
      bucket: rows[rows.length - 1].bucket,
      mmr: rows[rows.length - 1].closeMmr,
    },
  };
}

/**
 * Tilt + within-session momentum. Returns the user's WR after a win
 * vs after a loss (sequential, same-session only), plus a per-
 * position curve so the client can plot "WR by game number in the
 * session" — the headline answer to "do you tilt, or warm up?".
 *
 * Session = consecutive games separated by less than
 * ``SESSION_GAP_MINUTES`` of clock time. Games matching the global
 * filter set drive sessioning, so "weekend only" filtered correctly
 * means weekend sessions only.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @param {{ sessionGapMinutes?: number }} [opts]
 */
async function momentum(deps, userId, filters, opts = {}) {
  const gap = sanitizeGapMinutes(opts.sessionGapMinutes);
  const match = deps.gamesMatchStage(userId, filters);
  const pipeline = momentumPipeline(deps, match, gap);
  const [doc] = await deps.games.aggregate(pipeline).toArray();
  const post = (doc && doc.post) || [];
  const positions = (doc && doc.positions) || [];
  const baseline = (doc && doc.baseline && doc.baseline[0]) || null;
  return shapeMomentum({ post, positions, baseline, gap });
}

/** @param {Deps} deps @param {object} match @param {number} gapMinutes */
function momentumPipeline(deps, match, gapMinutes) {
  const gapMs = gapMinutes * 60 * 1000;
  return [
    { $match: match },
    { $addFields: { _bucket: deps.bucketSwitch() } },
    { $match: { _bucket: { $in: ["win", "loss"] } } },
    { $sort: { date: 1 } },
    ...sequentialContext(gapMs),
    { $facet: momentumFacet() },
  ];
}

/**
 * Window-field stages that decorate each game row with previous-
 * game context (gap to previous game, previous result, session id,
 * and within-session position).
 *
 * @param {number} gapMs
 */
function sequentialContext(gapMs) {
  return [
    {
      $setWindowFields: {
        sortBy: { date: 1 },
        output: {
          _prevDate: { $shift: { output: "$date", by: -1, default: null } },
          _prevResult: { $shift: { output: "$_bucket", by: -1, default: null } },
        },
      },
    },
    {
      $addFields: {
        _gapMs: { $cond: [{ $eq: ["$_prevDate", null] }, null, { $subtract: ["$date", "$_prevDate"] }] },
      },
    },
    {
      $addFields: {
        _sessionBreak: { $cond: [{ $or: [{ $eq: ["$_gapMs", null] }, { $gt: ["$_gapMs", gapMs] }] }, 1, 0] },
        _post: {
          $cond: [
            { $or: [{ $eq: ["$_prevDate", null] }, { $gt: ["$_gapMs", gapMs] }] },
            null,
            "$_prevResult",
          ],
        },
      },
    },
    {
      $setWindowFields: {
        sortBy: { date: 1 },
        output: {
          _sessionId: { $sum: "$_sessionBreak", window: { documents: ["unbounded", "current"] } },
        },
      },
    },
    {
      $setWindowFields: {
        partitionBy: "$_sessionId",
        sortBy: { date: 1 },
        output: { _pos: { $documentNumber: {} } },
      },
    },
  ];
}

/** $facet branches for the momentum pipeline — split out so the */
/* main pipeline reads as a 5-step flow. */
function momentumFacet() {
  const wlAgg = {
    wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
    losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
    total: { $sum: 1 },
  };
  return {
    post: [
      { $match: { _post: { $in: ["win", "loss"] } } },
      { $group: { _id: "$_post", ...wlAgg } },
    ],
    positions: [
      { $match: { _pos: { $lte: MAX_SESSION_POSITIONS } } },
      { $group: { _id: "$_pos", ...wlAgg } },
      { $sort: { _id: 1 } },
    ],
    baseline: [{ $group: { _id: null, ...wlAgg } }],
  };
}

/** @param {{post: any[], positions: any[], baseline: any, gap: number}} args */
function shapeMomentum({ post, positions, baseline, gap }) {
  const winRow = post.find((r) => r._id === "win") || { wins: 0, losses: 0, total: 0 };
  const lossRow = post.find((r) => r._id === "loss") || { wins: 0, losses: 0, total: 0 };
  return {
    sessionGapMinutes: gap,
    baseline: baseline
      ? {
          wins: baseline.wins,
          losses: baseline.losses,
          total: baseline.total,
          winRate: baseline.total ? baseline.wins / baseline.total : 0,
        }
      : { wins: 0, losses: 0, total: 0, winRate: 0 },
    postWin: {
      wins: winRow.wins,
      losses: winRow.losses,
      total: winRow.total,
      winRate: winRow.total ? winRow.wins / winRow.total : 0,
    },
    postLoss: {
      wins: lossRow.wins,
      losses: lossRow.losses,
      total: lossRow.total,
      winRate: lossRow.total ? lossRow.wins / lossRow.total : 0,
    },
    sessionPositions: positions.map((r) => ({
      pos: r._id,
      wins: r.wins,
      losses: r.losses,
      total: r.total,
      winRate: r.total ? r.wins / r.total : 0,
    })),
  };
}

/**
 * Win rate split by the spread between opponent's MMR and your MMR
 * at game time. Reveals whether you over- or under-perform vs
 * higher / lower-rated opponents.
 *
 * Only games where BOTH ``myMmr`` and ``opponent.mmr`` are numeric
 * are included; everything else falls into a separate ``unknown``
 * bucket the client can choose to hide.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 */
/**
 * Win rate bucketed by **absolute opponent MMR**, in clean 50- or
 * 100-MMR bands.
 *
 * Bucket width is either picked explicitly (``opts.bucketWidth``
 * = 50 or 100) or auto-chosen from the actual opponent-MMR spread
 * in the filtered data: tight ranges (≤500 MMR end-to-end) get
 * 50-wide bins so the picture has detail, wider ranges get 100-wide
 * bins so the chart doesn't fan out into 30+ thin bars. Either way
 * the response is self-describing — the chosen width is returned so
 * the client can label its toggle accurately.
 *
 * Games with no ``opponent.mmr`` are split into an ``unknown``
 * rollup the client can surface as a caption (never silently
 * dropped). Numeric guard uses ``$isNumber`` so int, long, double,
 * and decimal BSON types all match — the agent stores the field
 * as ``int(opp.mmr)`` so a literal type-name check would miss
 * every row (see PR #286).
 *
 * Fallback for missing per-game snapshot: sc2reader rarely surfaces
 * an opponent's MMR for ranked 1v1, so most games arrive with no
 * ``opponent.mmr``. When that's the case the pipeline $lookups the
 * opponents-collection row (keyed by ``(userId, pulseId)``) and
 * uses its ``mmr`` field — the same number the Opponents tab shows
 * — so the recent-vs-5900 game the user just played doesn't vanish
 * from the chart just because the replay didn't carry MMR.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @param {{ bucketWidth?: number | "auto" }} [opts]
 */
async function oppMmrBuckets(deps, userId, filters, opts = {}) {
  const match = deps.gamesMatchStage(userId, filters);
  const width = await resolveOppMmrBucketWidth(deps, match, opts.bucketWidth);
  const facet = await deps.games.aggregate(oppMmrPipeline(deps, match, width)).toArray();
  return shapeOppMmrBuckets(facet[0], width);
}

/**
 * Pick the bin width. Honours an explicit ``50`` / ``100`` from
 * the caller; for ``"auto"`` or anything unrecognised, queries
 * the data range and picks the cleaner default.
 *
 * The range probe joins in the opponents-row mmr fallback so a user
 * whose only high-MMR encounter has no per-game snapshot still gets
 * the wide-range (100-wide) layout when appropriate — otherwise the
 * width auto-pick would collapse to 50 from the snapshot-only span
 * and the AngryBird 5900 bin would end up off the chart.
 *
 * @param {Deps} deps
 * @param {object} match
 * @param {number | "auto" | undefined} requested
 */
async function resolveOppMmrBucketWidth(deps, match, requested) {
  if (requested === 50 || requested === 100) return requested;
  const rows = await deps.games
    .aggregate([
      { $match: match },
      ...oppMmrLookupStages(),
      { $match: { _oppMmr: { $type: "number" } } },
      {
        $group: {
          _id: null,
          mn: { $min: "$_oppMmr" },
          mx: { $max: "$_oppMmr" },
        },
      },
    ])
    .toArray();
  const extremes = rows && rows[0];
  if (!extremes || typeof extremes.mn !== "number" || typeof extremes.mx !== "number") {
    return 100;
  }
  const span = extremes.mx - extremes.mn;
  return span <= OPP_MMR_AUTO_WIDTH_CUTOFF ? 50 : 100;
}

/**
 * $lookup + $addFields stages that produce ``_oppMmr`` on each
 * input game: the per-game snapshot when numeric, otherwise the
 * opponents row's latest known ``mmr`` (sourced from SC2Pulse at
 * ingest time / by the backfill cron). Shared between the width
 * probe and the main bin pipeline so both see the same effective
 * MMR per game.
 *
 * The lookup is indexed (opponents has a unique
 * ``{userId, pulseId}``) and skipped at the document level when the
 * snapshot already exists, so the cost is amortised across the
 * majority of games that already carry it.
 */
function oppMmrLookupStages() {
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
 * Pipeline that fans games into absolute-MMR bins of ``width``
 * plus an unknown rollup, in one $facet so the response is one
 * round trip.
 */
function oppMmrPipeline(deps, match, width) {
  return [
    { $match: match },
    { $addFields: { _bucket: deps.bucketSwitch() } },
    { $match: { _bucket: { $in: ["win", "loss"] } } },
    ...oppMmrLookupStages(),
    {
      $facet: {
        bins: [
          { $match: { _oppMmr: { $type: "number" } } },
          {
            $addFields: {
              _bin: { $multiply: [{ $floor: { $divide: ["$_oppMmr", width] } }, width] },
            },
          },
          {
            $group: {
              _id: "$_bin",
              wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
              losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
              total: { $sum: 1 },
              avgMmr: { $avg: "$_oppMmr" },
              minMmr: { $min: "$_oppMmr" },
              maxMmr: { $max: "$_oppMmr" },
            },
          },
          { $sort: { _id: 1 } },
          { $limit: OPP_MMR_MAX_BUCKETS },
        ],
        unknown: [
          { $match: { _oppMmr: null } },
          {
            $group: {
              _id: null,
              wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
              losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
              total: { $sum: 1 },
            },
          },
        ],
      },
    },
  ];
}

function shapeOppMmrBuckets(facet, width) {
  const binRows = (facet && facet.bins) || [];
  const unknownRow = (facet && facet.unknown && facet.unknown[0]) || null;
  const buckets = binRows.map((r) => ({
    lo: r._id,
    hi: r._id + width,
    label: `${r._id}–${r._id + width - 1}`,
    wins: r.wins,
    losses: r.losses,
    total: r.total,
    winRate: r.total ? r.wins / r.total : 0,
    avgMmr: r.avgMmr != null ? Math.round(r.avgMmr) : null,
    minMmr: r.minMmr ?? null,
    maxMmr: r.maxMmr ?? null,
  }));
  return {
    bucketWidth: width,
    buckets,
    unknown: unknownRow
      ? { total: unknownRow.total, wins: unknownRow.wins, losses: unknownRow.losses }
      : { total: 0, wins: 0, losses: 0 },
  };
}

/**
 * Categorical mix over time. Used by:
 *   - my-build mix      (field = "$myBuild")
 *   - opp-strategy mix  (field = "$opponent.strategy")
 *
 * Returns ``{ interval, points: [{ bucket, key, total, wins, losses }] }``
 * — one row per (bucket, key) pair. Top-N selection and "Other"
 * roll-up happen client-side so the user can re-rank without a refetch.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
 * @param {object} filters
 * @param {{ field: string, fallback?: string }} cfg
 */
async function mixOverTime(deps, userId, opts, filters, cfg) {
  const interval = deps.pickInterval(opts && opts.interval);
  const timezone = deps.pickTimezone(opts && opts.tz);
  const match = deps.gamesMatchStage(userId, filters);
  const fallback = cfg.fallback || "Unknown";
  const rows = await deps.games
    .aggregate([
      { $match: match },
      { $addFields: { _bucket: deps.bucketSwitch() } },
      {
        $group: {
          _id: {
            bucket: { $dateTrunc: { date: "$date", unit: interval, timezone } },
            key: { $ifNull: [`$${cfg.field}`, fallback] },
          },
          wins: { $sum: { $cond: [{ $eq: ["$_bucket", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$_bucket", "loss"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
      { $sort: { "_id.bucket": 1, total: -1 } },
      { $limit: LIMITS.TIMESERIES_MAX_BUCKETS * 12 },
      {
        $project: {
          _id: 0,
          bucket: "$_id.bucket",
          key: "$_id.key",
          wins: 1,
          losses: 1,
          total: 1,
        },
      },
    ])
    .toArray();
  return { interval, points: rows };
}

/**
 * Per-map win-rate over time. Returns one row per (bucket, map)
 * pair; the client picks top-N maps by play volume and renders
 * faceted sparklines.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {{interval?: 'day'|'week'|'month', tz?: string}} opts
 * @param {object} filters
 */
async function mapTrend(deps, userId, opts, filters) {
  return mixOverTime(deps, userId, opts, filters, {
    field: "map",
    fallback: "Unknown",
  });
}

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

/**
 * Aggregation-pipeline mirror of ``regionFromToonHandle``: maps the
 * leading byte of a toon handle to a Blizzard region label. Used by
 * netMmrByMatchup so pairs only chain within the same region — a
 * region switch can't fake a thousand-MMR loss anymore.
 *
 * Games whose ``myToonHandle`` is missing or starts with an unknown
 * byte fall into "U" so they still chain among themselves (better
 * than dropping every pre-myToonHandle game).
 *
 * @param {string} field MongoDB field expression, e.g. ``"$myToonHandle"``.
 */
function regionFromToonHandleExpr(field) {
  return {
    $let: {
      vars: {
        head: { $substrCP: [{ $ifNull: [field, ""] }, 0, 1] },
      },
      in: {
        $switch: {
          branches: [
            { case: { $eq: ["$$head", "1"] }, then: "NA" },
            { case: { $eq: ["$$head", "2"] }, then: "EU" },
            { case: { $eq: ["$$head", "3"] }, then: "KR" },
            { case: { $eq: ["$$head", "5"] }, then: "CN" },
            { case: { $eq: ["$$head", "6"] }, then: "SEA" },
          ],
          default: "U",
        },
      },
    },
  };
}

function oppRaceSwitch() {
  return {
    $switch: {
      branches: [
        { case: oppRaceFirstChar("P"), then: "P" },
        { case: oppRaceFirstChar("T"), then: "T" },
        { case: oppRaceFirstChar("Z"), then: "Z" },
        { case: oppRaceFirstChar("R"), then: "R" },
      ],
      default: "U",
    },
  };
}

function oppRaceFirstChar(letter) {
  return {
    $eq: [
      { $toUpper: { $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1] } },
      letter,
    ],
  };
}

function sanitizeGapMinutes(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SESSION_GAP_MINUTES;
  // Clamp to a sane range — anything less than 15 minutes splits the
  // same Zerg ranked queue into bogus mini-sessions, anything past
  // 8 hours merges yesterday + today.
  return Math.max(15, Math.min(480, Math.round(n)));
}

module.exports = {
  mmrProgression,
  momentum,
  oppMmrBuckets,
  mixOverTime,
  mapTrend,
  netMmrByMatchup,
  SESSION_GAP_MINUTES,
  MAX_SESSION_POSITIONS,
  OPP_MMR_BUCKET_WIDTHS,
  OPP_MMR_AUTO_WIDTH_CUTOFF,
  NET_MMR_MAX_DELTA,
  RESULT_VICTORY,
  RESULT_DEFEAT,
};
