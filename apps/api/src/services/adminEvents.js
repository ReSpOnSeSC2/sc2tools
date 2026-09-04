"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const EVENT_TYPES = Object.freeze({
  USER_SIGNUP: "user_signup",
  AGENT_DOWNLOAD: "agent_download",
  USER_MESSAGE: "user_message",
});

/** @type {Set<string>} */
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
        // webhook the dedupe index already accepted. If this delivery
        // carries an email the first-touch event did not have yet,
        // converge that one row in place rather than creating a second
        // notification. The fill-only update preserves its source,
        // timestamps, read state, and event id.
        if (safePayload.email) {
          const enriched = await this.enrichSignupEmail(
            { clerkUserId: safePayload.clerkUserId },
            safePayload.email,
          );
          if (enriched) return enriched;
        }
        const existing = /** @type {AdminEventDoc | null} */ (
          await this.db.adminEvents.findOne(
            { type, "payload.clerkUserId": safePayload.clerkUserId },
            { projection: { _id: 0 } },
          )
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
    const rows = /** @type {AdminEventDoc[]} */ (
      /** @type {unknown} */ (
        await this.db.adminEvents
          .find(query, { projection: { _id: 0 } })
          .sort({ createdAt: -1 })
          .limit(limit + 1)
          .toArray()
      )
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // Older first-touch rows can pre-date the later Clerk email cache.
    // Decorate those rows from the authoritative users collection in one
    // query so existing notifications become useful without a migration.
    // This is response-only: event history and GDPR-anonymized rows remain
    // untouched.
    const items = await this._hydrateSignupEmails(page);
    const nextBefore = hasMore && items.length > 0
      ? items[items.length - 1].createdAt
      : null;
    return { items, nextBefore };
  }

  /**
   * Fill the email on an existing signup event. This method never inserts:
   * it is safe to call for Clerk ``user.updated`` deliveries belonging to
   * users whose signup predates the notification feed. Only a null/missing
   * email is eligible, and anonymized events are explicitly excluded.
   *
   * A successful enrichment is rebroadcast with the original event id so a
   * live admin client can replace its initial first-touch row. No-op calls
   * do not emit anything.
   *
   * @param {{ userId?: unknown, clerkUserId?: unknown }} identity
   * @param {unknown} rawEmail
   * @returns {Promise<AdminEventDoc | null>}
   */
  async enrichSignupEmail(identity, rawEmail) {
    const email = toCleanString(rawEmail, 254);
    if (!email) return null;
    const userId = toCleanString(identity && identity.userId, 64);
    const clerkUserId = toCleanString(
      identity && identity.clerkUserId,
      64,
    );
    /** @type {Record<string, unknown>[]} */
    const identities = [];
    if (userId) identities.push({ "payload.userId": userId });
    if (clerkUserId) {
      identities.push({ "payload.clerkUserId": clerkUserId });
    }
    if (identities.length === 0) return null;

    /** @type {Record<string, unknown>} */
    const query = {
      type: EVENT_TYPES.USER_SIGNUP,
      anonymizedAt: { $exists: false },
      // Equality with null also matches a missing field; the explicit empty
      // string covers the earliest legacy rows before sanitisation was
      // standardised.
      "payload.email": { $in: [null, ""] },
      ...(identities.length === 1
        ? identities[0]
        : { $or: identities }),
    };
    try {
      const updated = /** @type {AdminEventDoc | null} */ (
        await this.db.adminEvents.findOneAndUpdate(
          query,
          { $set: { "payload.email": email } },
          { returnDocument: "after", projection: { _id: 0 } },
        )
      );
      if (!updated) return null;
      this._broadcast(updated);
      return updated;
    } catch (err) {
      if (this.logger) {
        this.logger.warn(
          { err, userId: userId || null, clerkUserId: clerkUserId || null },
          "admin_signup_email_enrichment_failed",
        );
      }
      return null;
    }
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
      agents,
    ] = await Promise.all([
      this.db.users.countDocuments({}),
      this._rangeCount(EVENT_TYPES.USER_SIGNUP, dayAgo, weekAgo),
      this._rangeCount(EVENT_TYPES.AGENT_DOWNLOAD, dayAgo, weekAgo),
      this._platformBreakdown(),
      this.db.adminEvents.countDocuments({ readAt: null }),
      this._agentCounts(dayAgo, weekAgo),
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
      agents,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Connected-agent counters from the ``deviceTokens`` collection. Each
   * device token is one paired agent install; ``lastSeenAt`` is bumped
   * on every authenticated agent call / heartbeat, so a recent
   * ``lastSeenAt`` is the real "an agent is running" signal (a far
   * better answer to "is anyone using it?" than the download beacon,
   * which only fires on a website Download click).
   *
   * @param {Date} dayAgo
   * @param {Date} weekAgo
   * @returns {Promise<{ total: number, active24h: number, active7d: number }>}
   */
  async _agentCounts(dayAgo, weekAgo) {
    if (!this.db.deviceTokens) {
      return { total: 0, active24h: 0, active7d: 0 };
    }
    const [total, active24h, active7d] = await Promise.all([
      this.db.deviceTokens.countDocuments({}),
      this.db.deviceTokens.countDocuments({ lastSeenAt: { $gte: dayAgo } }),
      this.db.deviceTokens.countDocuments({ lastSeenAt: { $gte: weekAgo } }),
    ]);
    return { total, active24h, active7d };
  }

  /**
   * Batch-decorate legacy signup rows whose durable event payload has no
   * email but whose user record now does. Returns new event objects only
   * for hydrated rows; never writes to either collection.
   *
   * @param {AdminEventDoc[]} items
   * @returns {Promise<AdminEventDoc[]>}
   */
  async _hydrateSignupEmails(items) {
    const targets = items.filter(signupNeedsEmail);
    if (targets.length === 0) return items;
    const query = signupEmailUserQuery(targets);
    if (!query) return items;
    try {
      const users = await this.db.users
        .find(
          query,
          { projection: { _id: 0, userId: 1, clerkUserId: 1, email: 1 } },
        )
        .toArray();
      return hydrateSignupRows(items, users);
    } catch (err) {
      // Email decoration is optional. A users-collection blip must not hide
      // the durable notification feed that was already read successfully.
      if (this.logger) {
        this.logger.warn({ err }, "admin_signup_email_hydration_failed");
      }
      return items;
    }
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

/** @param {AdminEventDoc} item */
function signupNeedsEmail(item) {
  return Boolean(
    item &&
    item.type === EVENT_TYPES.USER_SIGNUP &&
    !item.anonymizedAt &&
    item.payload &&
    (item.payload.email == null || item.payload.email === ""),
  );
}

/**
 * @param {AdminEventDoc[]} items
 * @returns {Record<string, unknown> | null}
 */
function signupEmailUserQuery(items) {
  const userIds = new Set();
  const clerkUserIds = new Set();
  for (const item of items) {
    const userId = toCleanString(item.payload.userId, 64);
    const clerkUserId = toCleanString(item.payload.clerkUserId, 64);
    if (userId) userIds.add(userId);
    if (clerkUserId) clerkUserIds.add(clerkUserId);
  }
  /** @type {Record<string, unknown>[]} */
  const identities = [];
  if (userIds.size > 0) {
    identities.push({ userId: { $in: Array.from(userIds) } });
  }
  if (clerkUserIds.size > 0) {
    identities.push({ clerkUserId: { $in: Array.from(clerkUserIds) } });
  }
  if (identities.length === 0) return null;
  return identities.length === 1 ? identities[0] : { $or: identities };
}

/**
 * @param {AdminEventDoc[]} items
 * @param {Record<string, unknown>[]} users
 * @returns {AdminEventDoc[]}
 */
function hydrateSignupRows(items, users) {
  const byUserId = new Map();
  const byClerkUserId = new Map();
  for (const user of users) {
    const email = toCleanString(user.email, 254);
    if (!email) continue;
    const userId = toCleanString(user.userId, 64);
    const clerkUserId = toCleanString(user.clerkUserId, 64);
    if (userId) byUserId.set(userId, email);
    if (clerkUserId) byClerkUserId.set(clerkUserId, email);
  }
  return items.map((item) => {
    if (!signupNeedsEmail(item)) return item;
    const userId = toCleanString(item.payload.userId, 64);
    const clerkUserId = toCleanString(item.payload.clerkUserId, 64);
    const email =
      (userId ? byUserId.get(userId) : null) ||
      (clerkUserId ? byClerkUserId.get(clerkUserId) : null) ||
      null;
    return email ? { ...item, payload: { ...item.payload, email } } : item;
  });
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
 *   anonymizedAt?: Date,
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
 *   agents: { total: number, active24h: number, active7d: number },
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
