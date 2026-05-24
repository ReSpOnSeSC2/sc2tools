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
// Allowed values for the Users-tab segment filter. Anything outside
// this set falls back to "all" so a bad query param can't inject a
// pipeline stage or quietly skew the list.
const USER_LIST_FILTERS = new Set([
  "all",
  "with_games",
  "no_games",
  "with_agent",
]);

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
   * Optional ``filter`` narrows the result set:
   *   - ``"all"``        — every user (default)
   *   - ``"with_games"`` — users who have uploaded at least one game
   *   - ``"no_games"``   — signed-up users with zero games yet
   *   - ``"with_agent"`` — users who have paired at least one agent
   *
   * @param {{ limit?: number, before?: Date, search?: string,
   *   filter?: string }} [opts]
   * @returns {Promise<{
   *   items: Array<{
   *     userId: string,
   *     clerkUserId: string | null,
   *     email: string | null,
   *     gameCount: number,
   *     opponentCount: number,
   *     lastActivity: Date | null,
   *     firstActivity: Date | null,
   *     hasAgent: boolean,
   *     agentLastSeenAt: Date | null,
   *     storageEstimateBytes: number,
   *   }>,
   *   nextBefore: Date | null,
   * }>}
   */
  async listUsers(opts = {}) {
    const limit = clampLimit(opts.limit, 50);
    // Whitelist the filter so an unknown value can never inject a stage
    // or silently return the wrong set — anything unrecognised is "all".
    const filter = USER_LIST_FILTERS.has(opts.filter) ? opts.filter : "all";
    // Users-FIRST pipeline so signed-up users who have not uploaded any
    // games yet still appear (they show with 0 games). The older
    // games-first aggregation hid them entirely, which made the list
    // disagree with the "total users" counter.
    const pipeline = [];
    if (typeof opts.search === "string" && opts.search.length > 0) {
      // Case-insensitive match on userId / clerkUserId / email.
      const re = new RegExp(escapeRegex(opts.search), "i");
      pipeline.push({
        $match: { $or: [{ userId: re }, { clerkUserId: re }, { email: re }] },
      });
    }
    pipeline.push(
      // Per-user game count + activity bounds. ``date`` on games is
      // indexed per userId, so the correlated lookup is cheap at the
      // admin's scale and keeps users with zero games in the result.
      {
        $lookup: {
          from: COLLECTIONS.GAMES,
          let: { uid: "$userId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$uid"] } } },
            {
              $group: {
                _id: null,
                gameCount: { $sum: 1 },
                firstActivity: { $min: "$date" },
                lastActivity: { $max: "$date" },
              },
            },
          ],
          as: "gameStats",
        },
      },
      {
        $addFields: {
          gameStats: {
            $ifNull: [
              { $arrayElemAt: ["$gameStats", 0] },
              { gameCount: 0, firstActivity: null, lastActivity: null },
            ],
          },
        },
      },
      // Per-user paired-agent status from deviceTokens (one token per
      // agent install). ``count`` powers the "Has agent" filter/badge;
      // ``lastSeenAt`` is the newest heartbeat across the user's agents.
      {
        $lookup: {
          from: COLLECTIONS.DEVICE_TOKENS,
          let: { uid: "$userId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$userId", "$$uid"] } } },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                lastSeenAt: { $max: "$lastSeenAt" },
              },
            },
          ],
          as: "agentStats",
        },
      },
      {
        $addFields: {
          agentStats: {
            $ifNull: [
              { $arrayElemAt: ["$agentStats", 0] },
              { count: 0, lastSeenAt: null },
            ],
          },
        },
      },
      // Coalesced sort key so game-less users (null lastActivity) still
      // order deterministically — newest by last game, else last sign-in,
      // else account creation. The cursor (`before`) compares against it.
      {
        $addFields: {
          sortKey: {
            $ifNull: [
              "$gameStats.lastActivity",
              { $ifNull: ["$lastSeenAt", "$createdAt"] },
            ],
          },
        },
      },
    );
    // Segment filter — applied after the stat lookups so it can key on
    // the derived counts, and before the cursor/limit so pagination
    // counts only matching rows.
    if (filter === "with_games") {
      pipeline.push({ $match: { "gameStats.gameCount": { $gt: 0 } } });
    } else if (filter === "no_games") {
      pipeline.push({ $match: { "gameStats.gameCount": { $eq: 0 } } });
    } else if (filter === "with_agent") {
      pipeline.push({ $match: { "agentStats.count": { $gt: 0 } } });
    }
    pipeline.push({ $sort: { sortKey: -1 } });
    if (opts.before instanceof Date && !Number.isNaN(opts.before.getTime())) {
      pipeline.push({ $match: { sortKey: { $lt: opts.before } } });
    }
    pipeline.push({ $limit: limit + 1 });

    const rows = await this.db.users.aggregate(pipeline).toArray();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    if (page.length === 0) {
      return { items: [], nextBefore: null };
    }
    // Per-user opponent counts via a single grouped query — cheaper
    // than N round-trips. ``$in`` on the indexed ``userId`` field
    // makes this O(log N) per user.
    const userIds = page.map((r) => r.userId);
    const oppCounts = await this.db.opponents
      .aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
      ])
      .toArray();
    const oppCountByUser = new Map(oppCounts.map((c) => [c._id, c.count]));
    const items = page.map((r) => {
      const g = r.gameStats || {};
      const a = r.agentStats || {};
      return {
        userId: String(r.userId || ""),
        clerkUserId: r.clerkUserId ? String(r.clerkUserId) : null,
        email: r.email ? String(r.email) : null,
        gameCount: Number(g.gameCount) || 0,
        opponentCount: oppCountByUser.get(r.userId) || 0,
        lastActivity: g.lastActivity instanceof Date ? g.lastActivity : null,
        firstActivity: g.firstActivity instanceof Date ? g.firstActivity : null,
        hasAgent: (Number(a.count) || 0) > 0,
        agentLastSeenAt: a.lastSeenAt instanceof Date ? a.lastSeenAt : null,
        // Coarse storage estimate placeholder — gameDetails overhead is
        // tracked separately in ``storageStats``.
        storageEstimateBytes: 0,
      };
    });
    const nextBefore = hasMore && page.length > 0
      ? page[page.length - 1].sortKey
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
      email: user ? user.email || null : null,
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
   * Drop every opponent row for one user, re-derive from games,
   * THEN heal any rows whose ``pulseCharacterId`` is missing by
   * resolving against SC2Pulse. Wraps the combined GDPR helper so
   * the route layer doesn't have to reach across services.
   *
   * Returns the rebuild count and the pulse-backfill summary so
   * the admin UI can render "dropped N rows · resolved M pulse
   * ids" in one shot.
   *
   * @param {string} userId
   * @returns {Promise<{
   *   userId: string,
   *   droppedRows: number,
   *   pulseBackfill: {
   *     scanned: number,
   *     resolved: number,
   *     updated: number,
   *     skipped: number,
   *   } | null,
   * }>}
   */
  async rebuildOpponentsForUser(userId) {
    if (!userId) throw new Error("userId required");
    const result = await this.gdpr.rebuildOpponentsAndHealForUser(userId);
    return {
      userId,
      droppedRows: result.droppedRows,
      pulseBackfill: result.pulseBackfill,
    };
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
