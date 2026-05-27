"use strict";

/**
 * Opponent-MMR histogram + drilldown aggregations for the Trends tab.
 *
 * Carved out of ``trendsInsights.js`` so that file stays within the
 * per-file size budget. Everything here shares the same ``deps``
 * contract as its siblings — ``{ games, gamesMatchStage,
 * bucketSwitch }`` — so ``AggregationsService`` call sites remain
 * one-liners.
 *
 * The two public entry points are:
 *   - ``oppMmrBuckets``      — the win-rate-by-MMR histogram.
 *   - ``oppMmrBucketGames``  — the games behind one histogram tile.
 *
 * Both derive each game's *effective* opponent MMR identically
 * (``oppMmrLookupStages``: per-game snapshot first, opponents-row
 * fallback second), so a tile that reads "N games" lists exactly
 * those N games.
 *
 * @typedef {{
 *   games: import('mongodb').Collection,
 *   gamesMatchStage: (userId: string, filters: object) => object,
 *   bucketSwitch: () => object,
 * }} Deps
 */

/** Bucket widths offered by the opponent-MMR histogram. */
const OPP_MMR_BUCKET_WIDTHS = [50, 100];
/** Range threshold (in MMR) below which 50-wide bins read cleaner. */
const OPP_MMR_AUTO_WIDTH_CUTOFF = 500;
/** Safety cap so a malformed payload can't fan out to thousands of bins. */
const OPP_MMR_MAX_BUCKETS = 80;
/** Hard cap on a single MMR-band drilldown so a wide manual band
 *  (or a pathological filter) can't stream tens of thousands of rows
 *  to the client at once. A real 50/100-wide bracket tops out well
 *  under this. */
const OPP_MMR_BAND_GAMES_MAX = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How recent a game must be for the opponent's *current / last-known*
 * MMR to count as a fair proxy for their MMR *at game time*.
 *
 * Why this guard exists: sc2reader almost never records an opponent's
 * MMR for ranked 1v1, so the histogram leans on a SC2Pulse-sourced
 * "current MMR" (stamped onto the game at ingest, or joined from the
 * opponents row). That value is the opponent's rating *today* — a fine
 * stand-in for a game played last week, but flatly wrong for a game
 * from years ago (a 2018 opponent who is 6159 today was nowhere near
 * 6159 back then). Beyond this window we'd rather show the game as
 * "missing MMR" than bucket it under a rating it never had. One year
 * is the agreed trust horizon — roughly a few ladder seasons, where
 * ratings haven't drifted into a different league.
 */
const OPP_MMR_TRUST_MAX_AGE_DAYS = 365;

/**
 * The cutoff date before which a current/last-known opponent MMR is no
 * longer trusted as game-time MMR. Pure function of "now" so the
 * histogram + drilldown + width probe all share one boundary per
 * request.
 *
 * @param {number} [now]
 * @returns {Date}
 */
function oppMmrTrustFloor(now = Date.now()) {
  return new Date(now - OPP_MMR_TRUST_MAX_AGE_DAYS * DAY_MS);
}

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
  const trustFloor = oppMmrTrustFloor();
  const width = await resolveOppMmrBucketWidth(deps, match, opts.bucketWidth, trustFloor);
  const facet = await deps.games
    .aggregate(oppMmrPipeline(deps, match, width, trustFloor))
    .toArray();
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
 * @param {Date} trustFloor Games older than this contribute no MMR.
 */
async function resolveOppMmrBucketWidth(deps, match, requested, trustFloor) {
  if (requested === 50 || requested === 100) return requested;
  const rows = await deps.games
    .aggregate([
      { $match: match },
      ...oppMmrLookupStages(trustFloor),
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
 *
 * ``trustFloor`` gates the result: a game played before it gets
 * ``_oppMmr: null`` regardless of snapshot/fallback, because the only
 * MMR we have for it is a *current* rating that can't be trusted as
 * game-time MMR that far back (see ``OPP_MMR_TRUST_MAX_AGE_DAYS``).
 * Those games fall into the "missing opponent MMR" rollup rather than
 * polluting a bracket they never belonged to.
 *
 * Race guard on the fallback: the opponents row carries a *single* MMR
 * (one race), but a player has a separate rating per race. We only let
 * the opponents-row MMR stand in for a game when the row's race matches
 * the race the opponent actually played that game (first-letter match,
 * tolerant of "Protoss"/"P"). Otherwise a game vs their off-race would
 * borrow their main-race rating. The per-game snapshot is stamped
 * race-correctly upstream, so it needs no such check.
 *
 * @param {Date} trustFloor
 */
function oppMmrLookupStages(trustFloor) {
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
          { $project: { _id: 0, mmr: 1, race: 1 } },
        ],
        as: "_opp",
      },
    },
    {
      $addFields: {
        _oppMmr: {
          $cond: [
            { $gte: ["$date", trustFloor] },
            {
              $let: {
                vars: {
                  snap: "$opponent.mmr",
                  fallback: { $first: "$_opp.mmr" },
                  oppRowRace: {
                    $toUpper: {
                      $substrCP: [
                        { $ifNull: [{ $first: "$_opp.race" }, ""] },
                        0,
                        1,
                      ],
                    },
                  },
                  gameRace: {
                    $toUpper: {
                      $substrCP: [{ $ifNull: ["$opponent.race", ""] }, 0, 1],
                    },
                  },
                },
                in: {
                  $cond: [
                    { $isNumber: "$$snap" },
                    "$$snap",
                    {
                      $cond: [
                        {
                          $and: [
                            { $isNumber: "$$fallback" },
                            { $ne: ["$$oppRowRace", ""] },
                            { $eq: ["$$oppRowRace", "$$gameRace"] },
                          ],
                        },
                        "$$fallback",
                        null,
                      ],
                    },
                  ],
                },
              },
            },
            null,
          ],
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
function oppMmrPipeline(deps, match, width, trustFloor) {
  return [
    { $match: match },
    { $addFields: { _bucket: deps.bucketSwitch() } },
    { $match: { _bucket: { $in: ["win", "loss"] } } },
    ...oppMmrLookupStages(trustFloor),
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
 * The games that fall inside one opponent-MMR band — the drilldown
 * behind a tile in the "Win rate by opponent MMR" card. Reuses the
 * exact same effective-MMR derivation (`oppMmrLookupStages`) the
 * histogram bins with, so a tile that reads "5400–5499 · 14 games"
 * lists precisely those 14 games — including the ones whose MMR came
 * from the opponents-collection fallback rather than the per-game
 * snapshot.
 *
 * Rows are projected into the SPA's ``ProfileGame`` shape (so the
 * shared AllGamesTable renders them unchanged) plus ``opp_mmr`` /
 * ``my_mmr`` so the user can eyeball the actual per-game MMR that put
 * each game in this band — the whole point of the drilldown.
 *
 * @param {Deps} deps
 * @param {string} userId
 * @param {object} filters
 * @param {{ lo: number, hi: number }} opts
 */
async function oppMmrBucketGames(deps, userId, filters, opts = {}) {
  const lo = Number(opts.lo);
  const hi = Number(opts.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return { ok: true, lo: null, hi: null, total: 0, count: 0, games: [] };
  }
  const match = deps.gamesMatchStage(userId, filters);
  const trustFloor = oppMmrTrustFloor();
  const pipeline = [
    { $match: match },
    { $addFields: { _bucket: deps.bucketSwitch() } },
    { $match: { _bucket: { $in: ["win", "loss"] } } },
    ...oppMmrLookupStages(trustFloor),
    {
      $match: {
        _oppMmr: { $type: "number", $gte: lo, $lt: hi },
      },
    },
    {
      $project: {
        _id: 0,
        id: "$gameId",
        date: 1,
        map: { $ifNull: ["$map", ""] },
        opponent: { $ifNull: ["$opponent.displayName", ""] },
        opp_race: { $ifNull: ["$opponent.race", ""] },
        opp_strategy: { $ifNull: ["$opponent.strategy", null] },
        result: { $ifNull: ["$result", ""] },
        my_build: { $ifNull: ["$myBuild", null] },
        game_length: { $ifNull: ["$durationSec", 0] },
        macro_score: { $ifNull: ["$macroScore", null] },
        my_race: { $ifNull: ["$myRace", ""] },
        my_mmr: { $ifNull: ["$myMmr", null] },
        opp_mmr: { $round: ["$_oppMmr", 0] },
      },
    },
    { $sort: { date: -1 } },
    {
      $facet: {
        meta: [{ $count: "total" }],
        rows: [{ $limit: OPP_MMR_BAND_GAMES_MAX }],
      },
    },
  ];
  const [doc] = await deps.games.aggregate(pipeline).toArray();
  const total = (doc && doc.meta && doc.meta[0] && doc.meta[0].total) || 0;
  const games = (doc && doc.rows) || [];
  return { ok: true, lo, hi, total, count: games.length, games };
}

module.exports = {
  oppMmrBuckets,
  oppMmrBucketGames,
  oppMmrTrustFloor,
  OPP_MMR_BUCKET_WIDTHS,
  OPP_MMR_AUTO_WIDTH_CUTOFF,
  OPP_MMR_MAX_BUCKETS,
  OPP_MMR_TRUST_MAX_AGE_DAYS,
};
