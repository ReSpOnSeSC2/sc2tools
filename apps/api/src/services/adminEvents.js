"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const EVENT_TYPES = Object.freeze({
  USER_SIGNUP: "user_signup",
  AGENT_DOWNLOAD: "agent_download",
  USER_MESSAGE: "user_message",
});

const VALID_TYPES = new Set(Object.values(EVENT_TYPES));
const VALID_PLATFORMS = new Set(["windows", "macos", "linux"]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FEED_LIMIT_DEFAULT = 50;
const FEED_LIMIT_MAX = 200;
const SOCKET_ADMIN_ROOM = "admin";

// Length caps for user-submitted bug reports / messages. Mirrored by
// the POST /v1/messages route validation so an oversized body is
// rejected with a 400 before it ever reaches record(); these are the
// last line of defence that also keeps a row from growing unbounded.
const MESSAGE_SUBJECT_MAX = 140;
const MESSAGE_BODY_MAX = 4000;

/**
 * AdminEventsService — durable, queryable feed of admin-facing
 * notifications. Currently records two event types:
 *
 *   - ``user_signup``     — fired when a Clerk webhook delivers a
 *                            ``user.created`` event OR a first-touch
 *                            REST call lands a brand-new ``users``
 *                            row via ``ensureFromClerk``. The unique
 *                            partial index in ``db/connect.js`` makes
 *                            duplicate inserts on retry/race a no-op.
 *   - ``agent_download``  — fired when the public download endpoint
 *                            (`POST /v1/agent/download-event`) receives
 *                            a click beacon from the marketing page.
 *
 * Reads serve the admin dashboard's counters and notification feed.
 * Writes are real-time: when a Socket.io ``io`` is wired, each event
 * is broadcast to the ``admin`` room so connected admin tabs update
 * without polling.
 */
class AdminEventsService {
  /**
   * @param {{
   *   db: import('../db/connect').DbContext,
   *   io?: import('socket.io').Server | null,
   *   logger?: import('pino').Logger | null,
   * }} deps
   */
  constructor(deps) {
    if (!deps || !deps.db) throw new Error("AdminEventsService: db required");
    this.db = deps.db;
    this.io = deps.io || null;
    this.logger = deps.logger || null;
  }

  /**
   * Insert a new event row. Returns the persisted document (or the
   * row that already existed when the unique index rejects a
   * duplicate signup). Best-effort: a Mongo failure logs + returns
   * null without bubbling so the calling write path (Clerk webhook,
   * first-touch ensure, public download beacon) never 500s on the
   * notification side.
   *
   * @param {string} type
   * @param {Record<string, unknown>} payload
   * @returns {Promise<AdminEventDoc | null>}
   */
  async record(type, payload) {
    if (!VALID_TYPES.has(type)) {
      throw new Error(`AdminEventsService.record: invalid type '${type}'`);
    }
    const safePayload = sanitisePayload(type, payload);
    const doc = stampVersion(
      {
        eventId: crypto.randomUUID(),
        type,
        payload: safePayload,
        createdAt: new Date(),
        readAt: null,
      },
      COLLECTIONS.ADMIN_EVENTS,
    );
    try {
      await this.db.adminEvents.insertOne(doc);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 11000 && type === EVENT_TYPES.USER_SIGNUP) {
        // Idempotent retry path — Clerk re-delivered a user.created
        // webhook the dedupe index already accepted. Surface the
        // existing row so the caller can still log a hit.
        const existing = await this.db.adminEvents.findOne(
          { type, "payload.clerkUserId": safePayload.clerkUserId },
          { projection: { _id: 0 } },
        );
        return existing || null;
      }
      if (this.logger) {
        this.logger.warn(
          { err, type, eventId: doc.eventId },
          "admin_event_insert_failed",
        );
      }
      return null;
    }
    this._broadcast(doc);
    return doc;
  }

  /**
   * Reverse-chronological feed for the admin notifications page.
   * Cursor pagination on ``createdAt`` so the URL is stable.
   *
   * @param {{ limit?: number, before?: Date, type?: string }} [opts]
   * @returns {Promise<{ items: AdminEventDoc[], nextBefore: Date | null }>}
   */
  async list(opts = {}) {
    const limit = clampLimit(opts.limit, FEED_LIMIT_DEFAULT);
    /** @type {Record<string, any>} */
    const query = {};
    if (typeof opts.type === "string" && VALID_TYPES.has(opts.type)) {
      query.type = opts.type;
    }
    if (opts.before instanceof Date && !Number.isNaN(opts.before.getTime())) {
      query.createdAt = { $lt: opts.before };
    }
    const rows = await this.db.adminEvents
      .find(query, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextBefore = hasMore && items.length > 0
      ? items[items.length - 1].createdAt
      : null;
    return { items, nextBefore };
  }

  /**
   * Counters for the dashboard. Computes:
   *
   *   - totalUsers / signupsToday / signupsThisWeek
   *   - totalDownloads / downloadsToday / downloadsThisWeek
   *   - downloads by platform (windows / macos / linux)
   *   - unreadCount across all types
   *
   * Total user count reads from the ``users`` collection (the
   * authoritative source) rather than the event stream so backfilled
   * users without a recorded signup event still count.
   *
   * @returns {Promise<EventCounts>}
   */
  async counts() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - MS_PER_DAY);
    const weekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
    const [
      totalUsers,
      signupRange,
      downloadRange,
      downloadPlatforms,
      unreadCount,
    ] = await Promise.all([
      this.db.users.countDocuments({}),
      this._rangeCount(EVENT_TYPES.USER_SIGNUP, dayAgo, weekAgo),
      this._rangeCount(EVENT_TYPES.AGENT_DOWNLOAD, dayAgo, weekAgo),
      this._platformBreakdown(),
      this.db.adminEvents.countDocuments({ readAt: null }),
    ]);
    return {
      totalUsers,
      signupsToday: signupRange.day,
      signupsThisWeek: signupRange.week,
      totalSignupsTracked: signupRange.total,
      totalDownloads: downloadRange.total,
      downloadsToday: downloadRange.day,
      downloadsThisWeek: downloadRange.week,
      downloadsByPlatform: downloadPlatforms,
      unreadCount,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Mark every unread event as read. Returns the number of rows
   * touched so the SPA can clear the badge state confidently.
   *
   * @returns {Promise<{ markedRead: number }>}
   */
  async markAllRead() {
    const res = await this.db.adminEvents.updateMany(
      { readAt: null },
      { $set: { readAt: new Date() } },
    );
    return { markedRead: res.modifiedCount || 0 };
  }

  /**
   * @param {string} type
   * @param {Date} dayAgo
   * @param {Date} weekAgo
   */
  async _rangeCount(type, dayAgo, weekAgo) {
    const rows = await this.db.adminEvents
      .aggregate([
        { $match: { type } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            day: {
              $sum: { $cond: [{ $gte: ["$createdAt", dayAgo] }, 1, 0] },
            },
            week: {
              $sum: { $cond: [{ $gte: ["$createdAt", weekAgo] }, 1, 0] },
            },
          },
        },
      ])
      .toArray();
    const row = rows[0] || { total: 0, day: 0, week: 0 };
    return {
      total: Number(row.total) || 0,
      day: Number(row.day) || 0,
      week: Number(row.week) || 0,
    };
  }

  async _platformBreakdown() {
    const rows = await this.db.adminEvents
      .aggregate([
        { $match: { type: EVENT_TYPES.AGENT_DOWNLOAD } },
        { $group: { _id: "$payload.platform", count: { $sum: 1 } } },
      ])
      .toArray();
    /** @type {Record<string, number>} */
    const out = { windows: 0, macos: 0, linux: 0 };
    for (const row of rows) {
      const key = typeof row._id === "string" ? row._id : "";
      if (key in out) out[key] = Number(row.count) || 0;
    }
    return out;
  }

  /**
   * Push a freshly-recorded event to every connected admin socket.
   * Silently no-ops when no ``io`` was wired (test harness, smoke
   * environments) so the write path stays trivial.
   *
   * @param {AdminEventDoc} doc
   */
  _broadcast(doc) {
    if (!this.io) return;
    try {
      this.io.to(SOCKET_ADMIN_ROOM).emit("admin:event", doc);
    } catch (err) {
      if (this.logger) {
        this.logger.warn(
          { err, eventId: doc.eventId },
          "admin_event_broadcast_failed",
        );
      }
    }
  }
}

/**
 * @param {string} type
 * @param {Record<string, unknown>} raw
 */
function sanitisePayload(type, raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  if (type === EVENT_TYPES.USER_SIGNUP) {
    return {
      clerkUserId: toCleanString(payload.clerkUserId, 64),
      userId: toCleanString(payload.userId, 64) || null,
      email: toCleanString(payload.email, 254) || null,
      source: toCleanString(payload.source, 32) || "unknown",
    };
  }
  if (type === EVENT_TYPES.AGENT_DOWNLOAD) {
    const platformRaw = toCleanString(payload.platform, 16).toLowerCase();
    const platform = VALID_PLATFORMS.has(platformRaw) ? platformRaw : "unknown";
    return {
      platform,
      version: toCleanString(payload.version, 32) || null,
      channel: toCleanString(payload.channel, 16) || "stable",
      ip: maskIp(toCleanString(payload.ip, 64)),
      userAgent: toCleanString(payload.userAgent, 256) || null,
      referer: toCleanString(payload.referer, 256) || null,
      country: toCleanString(payload.country, 2) || null,
    };
  }
  if (type === EVENT_TYPES.USER_MESSAGE) {
    // A logged-in user's bug report / message. Identity (userId,
    // clerkUserId, email) is attached server-side from the auth
    // context, never trusted from the client body.
    return {
      userId: toCleanString(payload.userId, 64) || null,
      clerkUserId: toCleanString(payload.clerkUserId, 64) || null,
      email: toCleanString(payload.email, 254) || null,
      subject: toCleanString(payload.subject, MESSAGE_SUBJECT_MAX),
      message: toCleanString(payload.message, MESSAGE_BODY_MAX),
    };
  }
  return payload;
}

/**
 * Truncate an IP to a coarse network band so the feed never carries a
 * full client address. IPv4 keeps the first three octets; IPv6 keeps
 * the first 64 bits (the typical site prefix). Anything we can't
 * parse becomes null.
 *
 * @param {string} raw
 */
function maskIp(raw) {
  if (!raw) return null;
  const trimmed = raw.split(",")[0].trim();
  if (!trimmed) return null;
  if (trimmed.indexOf(":") >= 0) {
    const parts = trimmed.split(":");
    return parts.slice(0, 4).join(":") + "::/64";
  }
  const octets = trimmed.split(".");
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  return null;
}

/**
 * @param {unknown} raw
 * @param {number} max
 */
function toCleanString(raw, max) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 */
function clampLimit(raw, fallback) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, FEED_LIMIT_MAX);
}

/**
 * @typedef {{
 *   eventId: string,
 *   type: string,
 *   payload: Record<string, unknown>,
 *   createdAt: Date,
 *   readAt: Date | null,
 * }} AdminEventDoc
 *
 * @typedef {{
 *   totalUsers: number,
 *   signupsToday: number,
 *   signupsThisWeek: number,
 *   totalSignupsTracked: number,
 *   totalDownloads: number,
 *   downloadsToday: number,
 *   downloadsThisWeek: number,
 *   downloadsByPlatform: Record<string, number>,
 *   unreadCount: number,
 *   generatedAt: string,
 * }} EventCounts
 */

module.exports = {
  AdminEventsService,
  EVENT_TYPES,
  SOCKET_ADMIN_ROOM,
  MESSAGE_SUBJECT_MAX,
  MESSAGE_BODY_MAX,
};
