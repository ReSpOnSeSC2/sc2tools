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
const oppMmr = require("./trendsOppMmr");
const netMmr = require("./trendsNetMmr");
const { regionFromToonHandleExpr } = require("./trendsRegionExpr");

const RESULT_VICTORY = ["victory", "win"];
const RESULT_DEFEAT = ["defeat", "loss"];

/** Default gap that separates one ladder session from the next. */
const SESSION_GAP_MINUTES = 90;
/** Cap the within-session position bins — beyond this it's noise. */
const MAX_SESSION_POSITIONS = 12;

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
 * The response also carries:
 *
 *   - ``accounts``: one series per ``myToonHandle`` the user has
 *     played on. Each account carries its own region label (derived
 *     from the leading byte of the handle) and a friendly short
 *     label like "EU 267727" so the chart can paint one line per
 *     ladder account — a streamer with a main + smurf on the same
 *     region gets two NA lines instead of a misleading single line
 *     averaged between them. Pre-myToonHandle games (older agent
 *     versions) collapse into a single "Unknown" series.
 *
 *   - ``regions``: legacy roll-up of the above, one entry per
 *     Battle.net region. Kept for the previous chart iteration and
 *     any other consumer that wants the coarser cut. New work should
 *     prefer ``accounts``.
 *
 * The overall ``points`` / ``peak`` / ``trough`` / ``latest`` scalars
 * are preserved at the top level so existing consumers keep working
 * even if they ignore the new fields.
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
          // Normalise a missing / blank toon handle to the sentinel
          // "U" so it groups with the other Unknown rows instead of
          // creating a dozen ``null``-keyed series.
          _myAccount: {
            $cond: [
              { $and: [{ $ne: ["$myToonHandle", null] }, { $ne: ["$myToonHandle", ""] }] },
              "$myToonHandle",
              "U",
            ],
          },
        },
      },
      // Sort once before $facet so every sub-pipeline sees the same
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
          byAccount: [
            {
              $group: {
                _id: {
                  bucket: truncBucket,
                  toonHandle: "$_myAccount",
                  region: "$_myRegion",
                },
                ...groupAccumulators,
              },
            },
            // Per-toon-handle cap. A realistic ceiling is "a few
            // accounts" — 20 is generous and still well inside Mongo
            // pipeline memory.
            { $sort: { "_id.bucket": -1 } },
            { $limit: LIMITS.TIMESERIES_MAX_BUCKETS * 20 },
            { $sort: { "_id.toonHandle": 1, "_id.bucket": 1 } },
            {
              $project: {
                _id: 0,
                bucket: "$_id.bucket",
                toonHandle: "$_id.toonHandle",
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
  const root = facet[0] || { overall: [], byRegion: [], byAccount: [] };
  const overall = Array.isArray(root.overall) ? root.overall : [];
  const regions = groupRegionSeries(
    Array.isArray(root.byRegion) ? root.byRegion : [],
  );
  const accounts = groupAccountSeries(
    Array.isArray(root.byAccount) ? root.byAccount : [],
  );
  return {
    interval,
    points: overall,
    regions,
    accounts,
    ...summarize(overall),
  };
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
 * Bucket the flat per-(bucket, toonHandle) rows from the byAccount
 * facet into one series per Battle.net account. Each series carries
 * the region (so the chart can colour-code) and a short, friendly
 * label like "EU 267727" — the legend renders the latter so the
 * legend reads cleanly even when the user has several smurfs.
 *
 * Series order: by region (REGION_PRIORITY) then by total games
 * descending within a region — so the main account on each ladder
 * lands above its smurfs in the legend.
 *
 * @param {Array<{bucket: Date, toonHandle: string, region: string} & Record<string, number>>} rows
 */
function groupAccountSeries(rows) {
  /** @type {Map<string, {region: string, points: any[], totalGames: number}>} */
  const byKey = new Map();
  for (const r of rows) {
    const handle = r.toonHandle || "U";
    let bucket = byKey.get(handle);
    if (!bucket) {
      bucket = { region: r.region || "U", points: [], totalGames: 0 };
      byKey.set(handle, bucket);
    }
    bucket.points.push({
      bucket: r.bucket,
      openMmr: r.openMmr,
      closeMmr: r.closeMmr,
      minMmr: r.minMmr,
      maxMmr: r.maxMmr,
      wins: r.wins,
      losses: r.losses,
      total: r.total,
    });
    bucket.totalGames += r.total || 0;
  }
  const entries = Array.from(byKey.entries()).map(([handle, v]) => ({
    toonHandle: handle,
    region: v.region,
    label: shortAccountLabel(handle, v.region),
    points: v.points,
    totalGames: v.totalGames,
    ...summarize(v.points),
  }));
  entries.sort((a, b) => {
    const ra = REGION_PRIORITY.indexOf(a.region);
    const rb = REGION_PRIORITY.indexOf(b.region);
    const wa = ra === -1 ? REGION_PRIORITY.length : ra;
    const wb = rb === -1 ? REGION_PRIORITY.length : rb;
    if (wa !== wb) return wa - wb;
    // Main account (most games) first within a region.
    if (a.totalGames !== b.totalGames) return b.totalGames - a.totalGames;
    return a.toonHandle.localeCompare(b.toonHandle);
  });
  return entries.map(({ totalGames: _totalGames, ...rest }) => rest);
}

/**
 * Build a short, human-friendly label for a toon handle so the chart
 * legend doesn't have to display the raw "2-S2-1-267727" wire format.
 * Format: ``<REGION> <bnid>`` — e.g. "EU 267727". For the Unknown
 * sentinel the label is just "Unknown" so the headline reads cleanly
 * for old data that never carried a handle.
 *
 * @param {string} handle
 * @param {string} region
 */
function shortAccountLabel(handle, region) {
  if (!handle || handle === "U") return "Unknown";
  const segments = String(handle).split("-");
  const bnid = segments.length >= 4 ? segments[3] : segments[segments.length - 1];
  const safeRegion = region && region !== "U" ? region : "??";
  return `${safeRegion} ${bnid}`;
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

/** @param {unknown} raw */
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
  // Opponent-MMR histogram + drilldown live in ``./trendsOppMmr.js``;
  // re-exported here so existing ``trendsInsights.oppMmrBuckets`` call
  // sites keep working unchanged.
  oppMmrBuckets: oppMmr.oppMmrBuckets,
  oppMmrBucketGames: oppMmr.oppMmrBucketGames,
  mixOverTime,
  mapTrend,
  // Net-MMR-by-matchup lives in ``./trendsNetMmr.js``; re-exported so
  // existing ``trendsInsights.netMmrByMatchup`` / ``NET_MMR_MAX_DELTA``
  // call sites (incl. the netMmrByMatchup test) keep working.
  netMmrByMatchup: netMmr.netMmrByMatchup,
  SESSION_GAP_MINUTES,
  MAX_SESSION_POSITIONS,
  OPP_MMR_BUCKET_WIDTHS: oppMmr.OPP_MMR_BUCKET_WIDTHS,
  OPP_MMR_AUTO_WIDTH_CUTOFF: oppMmr.OPP_MMR_AUTO_WIDTH_CUTOFF,
  NET_MMR_MAX_DELTA: netMmr.NET_MMR_MAX_DELTA,
  RESULT_VICTORY,
  RESULT_DEFEAT,
};
