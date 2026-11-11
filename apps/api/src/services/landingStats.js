"use strict";

const { GUIDE_CURRENT_ERA } = require("../config/guides");
const { displayName, matchupSlug } = require("../config/guideSlugs");
const { publicBuildMongoExpression } = require("./communityBuildSnapshot");
const { publicCommunityBuildSnapshot } = require("./community");
const { cardView } = require("./reviews");

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const QUERY_MAX_TIME_MS = 2500;
const THRESHOLDS = Object.freeze({
  games: { min: 10_000, step: 100 },
  communityBuilds: { min: 25, step: 5 },
  answeredReviews: { min: 10, step: 5 },
  guideGames: { min: 1000, step: 100 },
});
const LANDING_LIMIT = 3;

/** Coalesce concurrent requests, including refreshes after the hour expires.
 * @template T @param {() => number} now @param {() => Promise<T>} read
 */
function hourly(now, read) {
  /** @type {T|undefined} */
  let snapshot;
  let expires = 0;
  /** @type {Promise<T>|null} */
  let pending = null;
  return () => {
    if (snapshot !== undefined && now() < expires) return Promise.resolve(snapshot);
    if (!pending) pending = read().then((value) => {
      snapshot = value;
      expires = now() + HOUR_MS;
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}

class LandingStatsService {
  /** @param {import('../db/connect').DbContext} db
   * @param {{now:()=>number, guidesEnabled?:boolean, reviewsEnabled?:boolean, logger?:{warn:Function}|null}} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.now = opts.now;
    this.guidesEnabled = opts.guidesEnabled === true;
    this.reviewsEnabled = opts.reviewsEnabled === true;
    this.logger = opts.logger;
    this.totals = hourly(this.now, () => this._readTotals());
    this.trends = hourly(this.now, () => this._readTrends());
  }

  /** @param {string} field @param {() => Promise<unknown>} read */
  async _count(field, read) {
    try {
      const value = await read();
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch (err) {
      this.logger?.warn({ err, field }, "landing_stat_unavailable");
      return null;
    }
  }

  async _readTotals() {
    const opts = { maxTimeMS: QUERY_MAX_TIME_MS };
    const [games, communityBuilds, answeredReviews, guideGames] = await Promise.all([
      this._count("games", () => this.db.games.estimatedDocumentCount(opts)),
      this._count("communityBuilds", () => this.db.communityBuilds.countDocuments({ removed: false }, opts)),
      this.reviewsEnabled ? this._count("answeredReviews", () => this.db.reviewRequests.countDocuments({ listed: true, status: "answered" }, opts)) : null,
      this.guidesEnabled ? this._count("guideGames", async () => (await this.db.guideStats.findOne(
        { kind: "run", key: "run" }, { ...opts, projection: { _id: 0, corpusGames: 1 } },
      ))?.corpusGames) : null,
    ]);
    return { games, communityBuilds, answeredReviews, guideGames, thresholds: THRESHOLDS };
  }

  async _readTrends() {
    if (!this.guidesEnabled) return [];
    const maxTimeMS = QUERY_MAX_TIME_MS;
    const run = await this.db.guideStats.findOne({ kind: "run", key: "run" }, { maxTimeMS, projection: { _id: 0, computedAt: 1 } });
    if (!(run?.computedAt instanceof Date)) return [];
    const rows = await this.db.guideStats.find(
      { kind: "build", era: GUIDE_CURRENT_ERA, computedAt: run.computedAt, published: true, "trend.winRateDelta": { $gt: 0 } },
      { maxTimeMS, projection: { _id: 0, matchup: 1, buildKey: 1, buildSlug: 1, trend: 1 } },
    ).sort({ "trend.winRateDelta": -1, "overall.games": -1, key: 1 }).limit(LANDING_LIMIT).toArray();
    return rows.flatMap((row) => {
      const slug = matchupSlug(row.matchup);
      if (!slug || typeof row.buildKey !== "string" || typeof row.buildSlug !== "string"
        || !(row.trend?.since instanceof Date)) return [];
      return [{
        name: displayName(row.buildKey), matchup: row.matchup, matchupSlug: slug, buildSlug: row.buildSlug,
        trend: { winRateDelta: row.trend.winRateDelta, prevalenceDelta: row.trend.prevalenceDelta ?? null, since: row.trend.since.toISOString() },
      }];
    });
  }

  async communityBuilds() {
    const { communityBuilds } = await this.totals();
    if (communityBuilds === null || communityBuilds < THRESHOLDS.communityBuilds.min) return [];
    const cutoff = new Date(this.now() - WEEK_MS);
    const rows = await this.db.communityBuilds.aggregate([
      { $match: { removed: false, publishedAt: { $gte: cutoff } } },
      { $sort: { votes: -1, publishedAt: -1, slug: 1 } },
      { $limit: LANDING_LIMIT },
      { $project: { _id: 0, slug: 1, title: 1, description: 1, matchup: 1, votes: 1, saves: 1, publishedAt: 1,
        contentUpdatedAt: 1, build: publicBuildMongoExpression("$build") } },
    ], { maxTimeMS: QUERY_MAX_TIME_MS }).toArray();
    return rows.map(publicCommunityBuildSnapshot);
  }

  async latestAnswered() {
    const { answeredReviews } = await this.totals();
    if (answeredReviews === null || answeredReviews < THRESHOLDS.answeredReviews.min) return null;
    const [row] = await this.db.reviewKarmaEvents.aggregate([
      { $match: { kind: "best" } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $lookup: { from: this.db.reviewRequests.collectionName, localField: "requestId", foreignField: "_id", as: "request" } },
      { $unwind: "$request" },
      { $match: { "request.listed": true, "request.status": "answered", $expr: { $eq: ["$request.bestCommentId", "$commentId"] } } },
      { $limit: 1 },
      { $project: { _id: 0, request: 1 } },
    ], { maxTimeMS: QUERY_MAX_TIME_MS }).toArray();
    return row ? cardView({ ...row.request, askerDisplay: "anonymous" }) : null;
  }
}

module.exports = { LandingStatsService, HOUR_MS };
