"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const K_ANONYMITY_THRESHOLD = 5;

/**
 * Projection used for every public listing/detail of a community
 * build. Centralised so list/detail/author-aggregate stay in sync —
 * anything new added to a build doc is automatically excluded from
 * public responses unless explicitly opted in here.
 */
const PUBLIC_PROJECTION = Object.freeze({
  _id: 0,
  slug: 1,
  ownerUserId: 1,
  title: 1,
  description: 1,
  matchup: 1,
  authorName: 1,
  votes: 1,
  publishedAt: 1,
  updatedAt: 1,
  build: 1,
});

/**
 * @param {Record<string, number>} counts
 * @param {number} total
 * @param {number} threshold — minimum share to qualify as dominant
 * @returns {string | null}
 */
function pickDominant(counts, total, threshold) {
  let best = "";
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  if (!best || total === 0) return null;
  return bestN / total >= threshold ? best : null;
}

/**
 * @param {Record<string, number>} counts
 * @returns {string | null}
 */
function pickTop(counts) {
  let best = "";
  let bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best || null;
}

/**
 * Community service.
 *
 * Two public-read entities:
 *   1. communityBuilds — user-published custom builds, slug-addressed,
 *      voted on, reportable.
 *   2. aggregated opponent profiles — derived from `games` across all
 *      users. K-anonymity gated: we only surface a row if at least
 *      K_ANONYMITY_THRESHOLD distinct users have faced that pulseId.
 *
 * Plus a moderation queue: communityReports holds user-flag records
 * resolved by an admin via the Clerk role check.
 */
class CommunityService {
  /**
   * @param {import('../db/connect').DbContext} db
   */
  constructor(db) {
    this.db = db;
  }

  // ── Builds ──────────────────────────────────────────────────────

  /**
   * Publish a custom build to the community. Idempotent on slug —
   * republishing updates the public copy.
   *
   * @param {string} userId
   * @param {string} userSlug — the private build's slug
   * @param {{title?: string, description?: string, authorName?: string}} meta
   */
  async publish(userId, userSlug, meta) {
    const priv = await this.db.customBuilds.findOne({
      userId,
      slug: userSlug,
      deletedAt: { $exists: false },
    });
    if (!priv) {
      const err = new Error("build_not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
    const slug = await this._uniqueSlug(meta.title || priv.name || userSlug);
    const now = new Date();
    /** @type {Record<string, any>} */
    const doc = {
      slug,
      ownerUserId: userId,
      sourceSlug: userSlug,
      title: meta.title || priv.name || userSlug,
      description: meta.description || "",
      authorName: meta.authorName || "",
      matchup: priv.matchup || "",
      build: priv,
      publishedAt: now,
      updatedAt: now,
      votes: 0,
      removed: false,
    };
    stampVersion(doc, COLLECTIONS.COMMUNITY_BUILDS);
    await this.db.communityBuilds.updateOne(
      { ownerUserId: userId, sourceSlug: userSlug },
      { $set: doc, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    return { slug };
  }

  /**
   * Unpublish (soft) by setting removed=true. The owner OR an admin
   * can call this; admin path adds a moderation note in the report.
   *
   * @param {string} userId
   * @param {string} slug
   * @param {{adminUserId?: string, reason?: string}} [opts]
   */
  async unpublish(userId, slug, opts = {}) {
    const filter = opts.adminUserId
      ? { slug }
      : { slug, ownerUserId: userId };
    const res = await this.db.communityBuilds.updateOne(filter, {
      $set: {
        removed: true,
        removedAt: new Date(),
        removedBy: opts.adminUserId || userId,
        removalReason: opts.reason || "owner_unpublish",
      },
    });
    if (res.matchedCount === 0) {
      const err = new Error("not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
  }

  /**
   * Public list — only non-removed builds, optionally filtered by
   * matchup or a free-text query. Sortable by top votes, newest, or
   * "controversial" (high engagement, near-50/50 vote split).
   *
   * `ownerUserId` is exposed so the frontend can link author chips to
   * `/community/authors/:userId`. It is our internal UUID, not the
   * Clerk id, so it's safe to surface publicly (decoupled from auth
   * provider, see UsersService.ensureFromClerk).
   *
   * @param {{
   *   matchup?: string,
   *   limit?: number,
   *   offset?: number,
   *   sort?: 'top' | 'new' | 'controversial',
   *   search?: string,
   * }} opts
   */
  async listPublic(opts = {}) {
    const filter = /** @type {Record<string, any>} */ ({ removed: false });
    if (opts.matchup) filter.matchup = opts.matchup;
    if (opts.search) {
      const escaped = String(opts.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "i");
      filter.$or = [
        { title: re },
        { description: re },
        { authorName: re },
      ];
    }
    const limit = Math.min(opts.limit || 30, 100);
    const offset = Math.max(0, Number(opts.offset) || 0);
    const sortKey = opts.sort || "top";
    /** @type {Record<string, 1 | -1>} */
    let sort;
    switch (sortKey) {
      case "new":
        sort = { publishedAt: -1, votes: -1 };
        break;
      case "controversial":
        // Controversial: lots of votes either way. We approximate by
        // ordering on the sum of upvotes + downvotes desc. The
        // pipeline path computes the sum field on the fly.
        return this._listControversial(filter, { limit, offset });
      case "top":
      default:
        sort = { votes: -1, publishedAt: -1 };
        break;
    }
    const cursor = this.db.communityBuilds
      .find(filter, { projection: PUBLIC_PROJECTION })
      .sort(sort)
      .skip(offset)
      .limit(limit + 1); // Fetch one extra to know whether more exist.
    const rows = await cursor.toArray();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const total = await this.db.communityBuilds.countDocuments(filter);
    return { items, hasMore, total, offset, limit };
  }

  /**
   * @param {Record<string, any>} filter
   * @param {{limit: number, offset: number}} page
   */
  async _listControversial(filter, page) {
    const items = await this.db.communityBuilds
      .aggregate([
        { $match: filter },
        {
          $addFields: {
            engagement: {
              $add: [
                { $size: { $ifNull: ["$upvotes", []] } },
                { $size: { $ifNull: ["$downvotes", []] } },
              ],
            },
          },
        },
        { $sort: { engagement: -1, publishedAt: -1 } },
        { $skip: page.offset },
        { $limit: page.limit + 1 },
        { $project: { ...PUBLIC_PROJECTION, engagement: 0 } },
      ])
      .toArray();
    const hasMore = items.length > page.limit;
    const total = await this.db.communityBuilds.countDocuments(filter);
    return {
      items: items.slice(0, page.limit),
      hasMore,
      total,
      offset: page.offset,
      limit: page.limit,
    };
  }

  /**
   * Public detail — full build content. 404s when removed.
   * Exposes `ownerUserId` (our internal UUID) so the frontend can link
   * to the author profile page.
   *
   * @param {string} slug
   */
  async getPublic(slug) {
    const row = await this.db.communityBuilds.findOne(
      { slug, removed: false },
      {
        // Strip Mongo-internal fields and the per-user vote arrays.
        // ownerUserId is intentionally exposed.
        projection: { _id: 0, upvotes: 0, downvotes: 0 },
      },
    );
    return row;
  }

  /**
   * Public author profile aggregate. Returns null when the author has
   * no published builds OR when none of their builds carry a public
   * `authorName` — that's the implicit "no public profile" opt-out.
   * Users who never declare a display name on a publish stay private.
   *
   * @param {string} userId — internal UUID (not Clerk id)
   * @returns {Promise<{
   *   userId: string,
   *   displayName: string,
   *   joinedAt: Date | null,
   *   builds: object[],
   *   totalBuilds: number,
   *   totalVotes: number,
   *   primaryRace: string | null,
   *   topMatchup: string | null,
   *   topBuild: object | null,
   *   recent: object[],
   * } | null>}
   */
  async getAuthor(userId) {
    if (!userId) return null;
    const builds = await this.db.communityBuilds
      .find(
        { ownerUserId: userId, removed: false },
        { projection: PUBLIC_PROJECTION },
      )
      .sort({ publishedAt: -1 })
      .toArray();
    if (builds.length === 0) return null;
    // Anonymization gate: at least one build must have a non-empty
    // authorName for the profile to be public. Users who publish
    // without a display name stay private (404 from the route).
    const named = builds.filter(
      (b) => typeof b.authorName === "string" && b.authorName.trim().length > 0,
    );
    if (named.length === 0) return null;
    // Most-recent declared authorName wins as the canonical display.
    const displayName = named[0].authorName.trim();
    const totalVotes = builds.reduce(
      (acc, b) => acc + (Number.isFinite(b.votes) ? b.votes : 0),
      0,
    );
    /** @type {Record<string, number>} */
    const raceCounts = {};
    /** @type {Record<string, number>} */
    const matchupCounts = {};
    for (const b of builds) {
      const r = b.build?.race;
      if (r) raceCounts[r] = (raceCounts[r] || 0) + 1;
      if (b.matchup) matchupCounts[b.matchup] = (matchupCounts[b.matchup] || 0) + 1;
    }
    const primaryRace = pickDominant(raceCounts, builds.length, 0.6);
    const topMatchup = pickTop(matchupCounts);
    const topBuild = builds.reduce((best, cur) => {
      if (!best) return cur;
      return (cur.votes ?? 0) > (best.votes ?? 0) ? cur : best;
    }, /** @type {any} */ (null));
    const joinedAt = builds.length
      ? builds.reduce((earliest, b) => {
          const t = b.publishedAt ? new Date(b.publishedAt).getTime() : NaN;
          if (!Number.isFinite(t)) return earliest;
          if (earliest == null || t < earliest) return t;
          return earliest;
        }, /** @type {number | null} */ (null))
      : null;
    return {
      userId,
      displayName,
      joinedAt: joinedAt != null ? new Date(joinedAt) : null,
      builds,
      totalBuilds: builds.length,
      totalVotes,
      primaryRace,
      topMatchup,
      topBuild,
      recent: builds.slice(0, 5),
    };
  }

  /**
   * @param {string} userId
   * @param {string} slug
   * @param {1 | -1} delta
   */
  async vote(userId, slug, delta) {
    if (delta !== 1 && delta !== -1) {
      const err = new Error("delta must be ±1");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    // We store one vote per (userId, slug) by stashing the vote inside
    // the build doc via $addToSet; rolling our own vote table is overkill
    // for the volumes we expect.
    const arr = delta === 1 ? "upvotes" : "downvotes";
    const opposite = delta === 1 ? "downvotes" : "upvotes";
    await this.db.communityBuilds.updateOne(
      { slug, removed: false },
      {
        $addToSet: { [arr]: userId },
        $pull: { [opposite]: userId },
      },
    );
    // Refresh the cached `votes` count.
    const row = await this.db.communityBuilds.findOne(
      { slug },
      { projection: { upvotes: 1, downvotes: 1 } },
    );
    if (row) {
      const u = Array.isArray(row.upvotes) ? row.upvotes.length : 0;
      const d = Array.isArray(row.downvotes) ? row.downvotes.length : 0;
      await this.db.communityBuilds.updateOne(
        { slug },
        { $set: { votes: u - d } },
      );
    }
  }

  // ── K-anonymous opponent profiles ────────────────────────────────

  /**
   * Compute aggregate stats for one pulseId across ALL users. Returns
   * null if fewer than K_ANONYMITY_THRESHOLD distinct users have faced
   * this opponent — public exposure of single-user data is a privacy
   * leak (you'd be able to recover individual battle tags by cross-
   * referencing).
   *
   * @param {string} pulseId
   */
  async aggregateOpponent(pulseId) {
    const games = await this.db.games
      .find(
        { "opponent.pulseId": pulseId },
        {
          projection: {
            userId: 1,
            result: 1,
            map: 1,
            "opponent.race": 1,
            "opponent.strategy": 1,
            "opponent.opening": 1,
            _id: 0,
          },
        },
      )
      .toArray();
    const distinctUsers = new Set(games.map((g) => g.userId));
    if (distinctUsers.size < K_ANONYMITY_THRESHOLD) {
      return null;
    }
    let wins = 0;
    let losses = 0;
    /** @type {Record<string, number>} */
    const openings = {};
    /** @type {Record<string, number>} */
    const strategies = {};
    /** @type {Record<string, {wins: number, losses: number}>} */
    const byMap = {};
    /** @type {string|undefined} */
    let race = undefined;
    for (const g of games) {
      // From the opponent's perspective: their wins are our losses.
      if (g.result === "Defeat") wins += 1;
      if (g.result === "Victory") losses += 1;
      if (!race && g.opponent?.race) race = g.opponent.race;
      const op = g.opponent?.opening;
      if (op) openings[op] = (openings[op] || 0) + 1;
      const st = g.opponent?.strategy;
      if (st) strategies[st] = (strategies[st] || 0) + 1;
      if (g.map) {
        if (!byMap[g.map]) byMap[g.map] = { wins: 0, losses: 0 };
        if (g.result === "Defeat") byMap[g.map].wins += 1;
        if (g.result === "Victory") byMap[g.map].losses += 1;
      }
    }
    const total = wins + losses;
    return {
      pulseId,
      race,
      contributors: distinctUsers.size,
      games: games.length,
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      openings,
      strategies,
      byMap,
    };
  }

  // ── Moderation queue ─────────────────────────────────────────────

  /**
   * @param {string} userId — reporter
   * @param {{targetType: 'build'|'opponent', targetId: string, reason: string, note?: string}} input
   */
  async report(userId, input) {
    if (!["build", "opponent"].includes(input.targetType)) {
      const err = new Error("targetType must be build|opponent");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    const reason = String(input.reason || "").slice(0, 80);
    if (!reason) {
      const err = new Error("reason required");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    await this.db.communityReports.insertOne(
      stampVersion(
        {
          id: crypto.randomUUID(),
          reporterUserId: userId,
          targetType: input.targetType,
          targetId: String(input.targetId),
          reason,
          note: String(input.note || "").slice(0, 1000),
          createdAt: new Date(),
          resolvedAt: null,
          resolution: null,
        },
        COLLECTIONS.COMMUNITY_REPORTS,
      ),
    );
  }

  /** @returns {Promise<{items: object[]}>} */
  async listReports() {
    const items = await this.db.communityReports
      .find({ resolvedAt: null }, { projection: { _id: 0 } })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();
    return { items };
  }

  /**
   * @param {string} adminUserId
   * @param {string} reportId
   * @param {{action: 'dismiss'|'remove', note?: string}} input
   */
  async resolveReport(adminUserId, reportId, input) {
    const report = await this.db.communityReports.findOne({ id: reportId });
    if (!report) {
      const err = new Error("report_not_found");
      /** @type {any} */ (err).status = 404;
      throw err;
    }
    if (input.action === "remove" && report.targetType === "build") {
      await this.unpublish("admin", report.targetId, {
        adminUserId,
        reason: input.note || "moderator_action",
      });
    }
    await this.db.communityReports.updateOne(
      { id: reportId },
      {
        $set: {
          resolvedAt: new Date(),
          resolvedBy: adminUserId,
          resolution: input.action,
          note: input.note || null,
        },
      },
    );
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Slug = title kebab-cased + 6 random hex chars to keep it unique
   * even when titles collide. We don't try to reuse old slugs because
   * the public URL is stable per publish.
   *
   * @param {string} title
   * @returns {Promise<string>}
   */
  async _uniqueSlug(title) {
    const base = String(title)
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "build";
    for (let i = 0; i < 5; i++) {
      const suffix = crypto.randomBytes(3).toString("hex");
      const candidate = `${base}-${suffix}`;
      const exists = await this.db.communityBuilds.findOne(
        { slug: candidate },
        { projection: { _id: 1 } },
      );
      if (!exists) return candidate;
    }
    // Fallback — astronomically unlikely.
    return `build-${crypto.randomBytes(8).toString("hex")}`;
  }
}

module.exports = { CommunityService, K_ANONYMITY_THRESHOLD };
