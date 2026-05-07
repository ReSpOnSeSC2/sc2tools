"use strict";

/**
 * AdminService — operational tools surfaced under ``/v1/admin/*``
 * and rendered by the ``/admin`` page in the SPA.
 *
 * Why a dedicated service
 * -----------------------
 * The day-to-day moderation flow already lives in CommunityService
 * (``/community/admin/reports``) and the agent-release admin lives in
 * AgentVersionService (``/agent/admin/releases``). This service owns
 * the *operational* admin: storage dashboards, per-user statistics,
 * data-integrity tools (rebuild opponents, wipe a user), and system
 * health checks. None of those cleanly belong to a domain service so
 * we keep them in one place.
 *
 * Authorization
 * -------------
 * Every method here trusts the caller — the route layer (``routes/admin.js``)
 * is responsible for the ``isAdmin(req)`` gate. That keeps this file
 * a pure data layer with no auth coupling, easy to unit-test against
 * an in-memory Mongo.
 */

const { COLLECTIONS } = require("../config/constants");

/**
 * Subset of collection names that have meaningful per-collection
 * stats and surface in the admin Dashboard. ``users`` and
 * ``profiles`` are tiny system collections; ``device_pairings`` is
 * a TTL working-set; ``agent_releases`` is operational metadata.
 * Listing them by name avoids surfacing the dozens of internal
 * collections (mlJobs, importJobs, etc.) that the dashboard
 * doesn't render.
 */
const DASHBOARD_COLLECTIONS = Object.freeze([
  COLLECTIONS.USERS,
  COLLECTIONS.PROFILES,
  COLLECTIONS.OPPONENTS,
  COLLECTIONS.GAMES,
  COLLECTIONS.GAME_DETAILS,
  COLLECTIONS.CUSTOM_BUILDS,
  COLLECTIONS.COMMUNITY_BUILDS,
  COLLECTIONS.COMMUNITY_REPORTS,
  COLLECTIONS.USER_BACKUPS,
  COLLECTIONS.AGENT_RELEASES,
  COLLECTIONS.DEVICE_TOKENS,
  COLLECTIONS.OVERLAY_TOKENS,
  COLLECTIONS.ML_MODELS,
]);

class AdminService {
  /**
   * @param {{
   *   db: import('../db/connect').DbContext,
   *   gdpr: import('./gdpr').GdprService,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.db) throw new Error("AdminService: db required");
    if (!deps.gdpr) throw new Error("AdminService: gdpr required");
    this.db = deps.db;
    this.gdpr = deps.gdpr;
    this._startedAt = Date.now();
  }

  /**
   * Per-collection storage breakdown. Calls ``collStats`` for every
   * dashboard collection in parallel, returning the same shape the
   * Atlas UI's "Browse Collections" panel renders. Skips collections
   * that don't exist yet (a fresh deploy hasn't seen its first
   * write).
   *
   * @returns {Promise<{
   *   totalDocs: number,
   *   totalDataBytes: number,
   *   totalStorageBytes: number,
   *   totalIndexBytes: number,
   *   collections: Array<{
   *     name: string,
   *     count: number,
   *     avgObjSize: number,
   *     storageSize: number,
   *     totalSize: number,
   *     indexSize: number,
   *   }>,
   * }>}
   */
  async storageStats() {
    const rawDb = this.db.db;
    const results = await Promise.all(
      DASHBOARD_COLLECTIONS.map(async (name) => {
        try {
          const stats = await rawDb.command({ collStats: name });
          return {
            name,
            count: Number(stats.count) || 0,
            avgObjSize: Number(stats.avgObjSize) || 0,
            storageSize: Number(stats.storageSize) || 0,
            totalSize: Number(stats.size) || 0,
            indexSize: Number(stats.totalIndexSize) || 0,
          };
        } catch (err) {
          // Collection doesn't exist yet — return a zero row so the
          // dashboard renders the name with "—" placeholders rather
          // than dropping it from the table entirely. Mongo's error
          // is "Collection [name] not found" with code 26.
          if (err && err.codeName === "NamespaceNotFound") {
            return {
              name,
              count: 0,
              avgObjSize: 0,
              storageSize: 0,
              totalSize: 0,
              indexSize: 0,
            };
          }
          throw err;
        }
      }),
    );
    let totalDocs = 0;
    let totalDataBytes = 0;
    let totalStorageBytes = 0;
    let totalIndexBytes = 0;
    for (const r of results) {
      totalDocs += r.count;
      totalDataBytes += r.totalSize;
      totalStorageBytes += r.storageSize;
      totalIndexBytes += r.indexSize;
    }
    return {
      totalDocs,
      totalDataBytes,
      totalStorageBytes,
      totalIndexBytes,
      collections: results.sort((a, b) => b.totalSize - a.totalSize),
    };
  }

  /**
   * Per-user activity summary for the Users tab. Returns the top-N
   * users by game count, each annotated with totals + last-activity
   * timestamp + opponent count. Designed to fit in a single screen
   * for ops review; the SPA paginates by passing ``before`` (the
   * lastActivity cursor of the previous page).
   *
   * @param {{ limit?: number, before?: Date, search?: string }} [opts]
   * @returns {Promise<{
   *   items: Array<{
   *     userId: string,
   *     clerkUserId: string | null,
   *     gameCount: number,
   *     opponentCount: number,
   *     lastActivity: Date | null,
   *     firstActivity: Date | null,
   *     storageEstimateBytes: number,
   *   }>,
   *   nextBefore: Date | null,
   * }>}
   */
  async listUsers(opts = {}) {
    const limit = clampLimit(opts.limit, 50);
    /** @type {Record<string, any>} */
    const userMatch = {};
    if (typeof opts.search === "string" && opts.search.length > 0) {
      // Case-insensitive ID search. We never index against PII (only
      // userId / clerkUserId) so the search surface is small.
      const re = new RegExp(escapeRegex(opts.search), "i");
      userMatch.$or = [{ userId: re }, { clerkUserId: re }];
    }
    // Aggregate game counts + activity bounds in one pipeline, then
    // join the user docs back in for the displayable identifier.
    const cursor = this.db.games.aggregate([
      {
        $group: {
          _id: "$userId",
          gameCount: { $sum: 1 },
          firstActivity: { $min: "$date" },
          lastActivity: { $max: "$date" },
        },
      },
      { $sort: { lastActivity: -1 } },
      ...(opts.before instanceof Date && !Number.isNaN(opts.before.getTime())
        ? [{ $match: { lastActivity: { $lt: opts.before } } }]
        : []),
      { $limit: limit + 1 },
      {
        $lookup: {
          from: COLLECTIONS.USERS,
          localField: "_id",
          foreignField: "userId",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      ...(userMatch.$or
        ? [{
          $match: {
            $or: [
              { _id: userMatch.$or[0].userId },
              { "user.clerkUserId": userMatch.$or[1].clerkUserId },
            ],
          },
        }]
        : []),
    ]);
    const rows = await cursor.toArray();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    if (page.length === 0) {
      return { items: [], nextBefore: null };
    }
    // Per-user opponent counts via a single grouped query — cheaper
    // than N round-trips. ``$in`` on the indexed ``userId`` field
    // makes this O(log N) per user.
    const userIds = page.map((r) => r._id);
    const oppCounts = await this.db.opponents
      .aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
      ])
      .toArray();
    const oppCountByUser = new Map(oppCounts.map((c) => [c._id, c.count]));
    const items = page.map((r) => ({
      userId: String(r._id || ""),
      clerkUserId: r.user && r.user.clerkUserId ? String(r.user.clerkUserId) : null,
      gameCount: Number(r.gameCount) || 0,
      opponentCount: oppCountByUser.get(r._id) || 0,
      lastActivity: r.lastActivity instanceof Date ? r.lastActivity : null,
      firstActivity: r.firstActivity instanceof Date ? r.firstActivity : null,
      // Coarse storage estimate — average game-doc size × game count.
      // Used only for sorting/triage in the admin UI; not a billing
      // figure. Overhead from gameDetails is tracked separately in
      // ``storageStats``.
      storageEstimateBytes: 0,
    }));
    const nextBefore = hasMore && items.length > 0
      ? items[items.length - 1].lastActivity
      : null;
    return { items, nextBefore };
  }

  /**
   * Detailed snapshot for one user — what the Users-tab "Open" drawer
   * shows. Includes counts, dates, MMR/race breakdown, and the
   * top-5 most-played opponents.
   *
   * @param {string} userId
   */
  async userDetail(userId) {
    if (!userId) throw new Error("userId required");
    const [
      user,
      gameStats,
      opponentCount,
      topOpponents,
    ] = await Promise.all([
      this.db.users.findOne({ userId }, { projection: { _id: 0 } }),
      this.db.games
        .aggregate([
          { $match: { userId } },
          {
            $group: {
              _id: null,
              gameCount: { $sum: 1 },
              wins: {
                $sum: { $cond: [{ $eq: ["$result", "Victory"] }, 1, 0] },
              },
              losses: {
                $sum: { $cond: [{ $eq: ["$result", "Defeat"] }, 1, 0] },
              },
              firstActivity: { $min: "$date" },
              lastActivity: { $max: "$date" },
            },
          },
        ])
        .toArray(),
      this.db.opponents.countDocuments({ userId }),
      this.db.opponents
        .find(
          { userId },
          {
            projection: {
              _id: 0,
              pulseId: 1,
              displayNameSample: 1,
              race: 1,
              gameCount: 1,
              wins: 1,
              losses: 1,
            },
          },
        )
        .sort({ gameCount: -1 })
        .limit(5)
        .toArray(),
    ]);
    const stats = gameStats[0] || {
      gameCount: 0,
      wins: 0,
      losses: 0,
      firstActivity: null,
      lastActivity: null,
    };
    return {
      userId,
      clerkUserId: user ? user.clerkUserId || null : null,
      createdAt: user ? user.createdAt || null : null,
      lastSeenAt: user ? user.lastSeenAt || null : null,
      games: {
        total: Number(stats.gameCount) || 0,
        wins: Number(stats.wins) || 0,
        losses: Number(stats.losses) || 0,
        firstActivity: stats.firstActivity instanceof Date ? stats.firstActivity : null,
        lastActivity: stats.lastActivity instanceof Date ? stats.lastActivity : null,
      },
      opponents: {
        total: opponentCount,
        top: topOpponents,
      },
    };
  }

  /**
   * Drop every opponent row for one user and re-derive from games.
   * Wraps GdprService.rebuildOpponentsForUser; the AdminService method
   * exists so the route layer doesn't have to reach across services.
   *
   * @param {string} userId
   * @returns {Promise<{ userId: string, droppedRows: number }>}
   */
  async rebuildOpponentsForUser(userId) {
    if (!userId) throw new Error("userId required");
    const droppedRows = await this.gdpr.rebuildOpponentsForUser(userId);
    return { userId, droppedRows };
  }

  /**
   * System health snapshot rendered on the Health tab. Pings Mongo,
   * reports uptime + Node version, and surfaces the configured
   * GameDetailsStore backend so admins can verify whether a deploy
   * is reading from R2 or Mongo without grepping env vars.
   *
   * @param {{
   *   gameDetailsStoreKind?: string,
   *   nodeVersion?: string,
   * }} [ctx]
   */
  async health(ctx = {}) {
    /** @type {{ ok: boolean, latencyMs: number | null, error: string | null }} */
    const mongo = { ok: false, latencyMs: null, error: null };
    const t0 = Date.now();
    try {
      await this.db.client.db().admin().ping();
      mongo.ok = true;
      mongo.latencyMs = Date.now() - t0;
    } catch (err) {
      mongo.error = err && err.message ? err.message : String(err);
    }
    return {
      mongo,
      uptime: {
        startedAt: new Date(this._startedAt).toISOString(),
        uptimeSeconds: Math.floor((Date.now() - this._startedAt) / 1000),
      },
      runtime: {
        nodeVersion: ctx.nodeVersion || process.version,
        gameDetailsStore: ctx.gameDetailsStoreKind || "mongo",
      },
    };
  }
}

/** @param {unknown} raw @param {number} fallback */
function clampLimit(raw, fallback) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 200);
}

/** @param {string} s */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { AdminService, DASHBOARD_COLLECTIONS };
