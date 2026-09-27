"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const TITLE_MAX = 140;
const BODY_MAX = 280;
const HREF_MAX = 300;
const KIND_RE = /^[a-z][a-z0-9_.]{1,63}$/;
const GROUP_KEY_MAX = 200;

/**
 * NotificationsService — the per-user in-app bell.
 *
 * Document: ``{_id, userId, kind, title, body, href, readAt, createdAt,
 * groupKey?, count}``. There is no email channel: the platform has no
 * email provider, so every notification is in-app only.
 *
 * Grouping: callers that would otherwise spam the bell (a burst of new
 * reviews on one request) pass a ``groupKey`` and a ``render(count)``
 * callback. While the recipient has an UNREAD row for that key, new
 * events fold into it (``count`` increments, title/body re-render,
 * ``createdAt`` bumps so it floats back to the top). The unique partial
 * index ``notification_unread_group`` makes the fold race-free.
 *
 * Live delivery: after every write the recipient's ``user:<userId>``
 * Socket.io room receives a ``notifications:changed`` ping (kind only —
 * overlay and agent sockets share that room), and an open tab refetches
 * its badge instead of polling.
 */
class NotificationsService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{io?: import('socket.io').Server, logger?: import('pino').Logger}} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.io = opts.io || null;
    this.logger = opts.logger || null;
  }

  /**
   * @param {string} userId recipient (internal id)
   * @param {{
   *   kind: string,
   *   title: string,
   *   body?: string,
   *   href?: string,
   *   groupKey?: string,
   *   render?: (count: number) => {title: string, body?: string},
   * }} input
   * @returns {Promise<Record<string, any> | null>} the stored row, or null when skipped
   */
  async notify(userId, input) {
    if (typeof userId !== "string" || !userId) return null;
    if (!KIND_RE.test(String(input.kind || ""))) throw new Error("invalid_notification_kind");
    const now = new Date();
    const href = safeHref(input.href);
    /** @type {Record<string, any> | null} */
    let row = null;
    if (input.groupKey) {
      row = await this._fold(userId, input, href, now);
    }
    if (!row) {
      row = stampVersion(
        {
          _id: `n_${crypto.randomBytes(12).toString("base64url")}`,
          userId,
          kind: input.kind,
          title: clip(input.title, TITLE_MAX),
          body: clip(input.body || "", BODY_MAX),
          href,
          count: 1,
          readAt: null,
          createdAt: now,
          ...(input.groupKey ? { groupKey: String(input.groupKey).slice(0, GROUP_KEY_MAX) } : {}),
        },
        COLLECTIONS.NOTIFICATIONS,
      );
      try {
        await this.db.notifications.insertOne(row);
      } catch (err) {
        // Lost a race with a concurrent first event for the same group:
        // the other writer created the unread row, so fold into it.
        if (!(input.groupKey && isDuplicateKey(err))) throw err;
        row = await this._fold(userId, input, href, now);
        if (!row) return null;
      }
    }
    if (!row) return null;
    this._push(userId, row);
    return row;
  }

  /**
   * @param {string} userId
   * @param {{kind: string, title: string, body?: string, groupKey?: string, render?: (count: number) => {title: string, body?: string}}} input
   * @param {string|null} href
   * @param {Date} now
   */
  async _fold(userId, input, href, now) {
    const groupKey = String(input.groupKey).slice(0, GROUP_KEY_MAX);
    const bumped = await this.db.notifications.findOneAndUpdate(
      { userId, groupKey, readAt: null },
      { $inc: { count: 1 }, $set: { createdAt: now, href } },
      { returnDocument: "after" },
    );
    if (!bumped) return null;
    const rendered = input.render ? input.render(Number(bumped.count) || 1) : null;
    if (rendered) {
      const title = clip(rendered.title, TITLE_MAX);
      const body = clip(rendered.body || "", BODY_MAX);
      await this.db.notifications.updateOne({ _id: bumped._id }, { $set: { title, body } });
      bumped.title = title;
      bumped.body = body;
    }
    return bumped;
  }

  /**
   * @param {string} userId
   * @param {{limit?: unknown, before?: unknown}} [opts]
   */
  async list(userId, opts = {}) {
    const limit = clampInt(opts.limit, 1, LIST_MAX, LIST_DEFAULT);
    /** @type {Record<string, any>} */
    const filter = { userId };
    const before = opts.before ? new Date(String(opts.before)) : null;
    if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
    const rows = await this.db.notifications
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();
    const items = rows.slice(0, limit).map(serialize);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last ? last.createdAt : null,
    };
  }

  /** @param {string} userId */
  async unreadCount(userId) {
    const count = await this.db.notifications.countDocuments(
      { userId, readAt: null },
      { limit: 100 },
    );
    return { count };
  }

  /**
   * @param {string} userId
   * @param {{ids?: unknown, all?: unknown}} input
   */
  async markRead(userId, input) {
    const now = new Date();
    if (input && input.all === true) {
      const res = await this.db.notifications.updateMany(
        { userId, readAt: null },
        { $set: { readAt: now } },
      );
      return { updated: res.modifiedCount || 0 };
    }
    const ids = Array.isArray(input?.ids)
      ? input.ids.filter((id) => typeof id === "string" && id.length <= 64).slice(0, 100)
      : [];
    if (ids.length === 0) return { updated: 0 };
    const res = await this.db.notifications.updateMany(
      { userId, _id: { $in: ids }, readAt: null },
      { $set: { readAt: now } },
    );
    return { updated: res.modifiedCount || 0 };
  }

  /** @param {string} userId */
  async deleteAllForUser(userId) {
    const res = await this.db.notifications.deleteMany({ userId });
    return res.deletedCount || 0;
  }

  /**
   * @param {string} userId
   * @param {Record<string, any>} row
   */
  _push(userId, row) {
    if (!this.io) return;
    try {
      // A ping, never the text: OBS overlay and desktop-agent sockets
      // share the ``user:<id>`` room. The web bell refetches over REST.
      this.io.to(`user:${userId}`).emit("notifications:changed", { kind: row.kind });
    } catch (err) {
      if (this.logger) this.logger.warn({ err }, "notification_push_failed");
    }
  }
}

/** @param {Record<string, any>} row */
function serialize(row) {
  return {
    id: row._id,
    kind: row.kind,
    title: row.title,
    body: row.body || "",
    href: row.href || null,
    count: Number(row.count) || 1,
    readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/**
 * Only same-site relative paths. A notification must never become an
 * open redirect or carry a ``javascript:`` URL into the bell.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function safeHref(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value.slice(0, HREF_MAX);
}

/** @param {unknown} value @param {number} max */
function clip(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

/** @param {unknown} raw @param {number} min @param {number} max @param {number} fallback */
function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {unknown} err */
function isDuplicateKey(err) {
  return Boolean(err && typeof err === "object" && /** @type {any} */ (err).code === 11000);
}

module.exports = { NotificationsService, safeHref };
