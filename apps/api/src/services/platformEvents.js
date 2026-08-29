"use strict";

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

const EVENT_TTL_MS = 48 * 60 * 60 * 1000;
const REPLAY_WINDOW_MS = 15 * 60 * 1000;
const REPLAY_LIMIT = 50;
const PLATFORMS = new Set(["twitch", "kick", "youtube", "tiktok"]);
const KINDS = new Set([
  "sub",
  "resub",
  "giftsub",
  "raid",
  "member",
  "superchat",
  "gift",
  "follow",
  "cheer",
  "share",
  "reward",
]);

class PlatformEventsService {
  /**
   * @param {{platformEvents: import('mongodb').Collection}} db
   * @param {{
   *   io?: import('socket.io').Server,
   *   overlayTokens: {list: (userId: string) => Promise<Array<Record<string, any>>>},
   *   now?: () => number,
   *   logger?: import('pino').Logger,
   * }} deps
   */
  constructor(db, deps) {
    this.col = db.platformEvents;
    this.io = deps.io || null;
    this.overlayTokens = deps.overlayTokens;
    this.now = deps.now || Date.now;
    this.logger = deps.logger || null;
  }

  /**
   * Persist before broadcast. If the process dies after the insert but before
   * emit, socket connect replay still delivers it; duplicate webhook retries
   * lose the unique-index race and never make a second alert sound.
   *
   * @param {string} userId
   * @param {Record<string, any>} rawEvent
   */
  async publish(userId, rawEvent) {
    const now = this.now();
    const event = sanitizeEvent(rawEvent, now);
    if (!userId || !event) return false;
    // Provider occurrence time is not necessarily delivery time. YouTube's
    // public-subscriber feed, in particular, can surface an action minutes
    // after its publishedAt value. Keep the trusted server receipt time on the
    // wire so an alert Browser Source that was briefly disconnected can decide
    // whether this is a genuinely missed live alert instead of treating every
    // delayed provider timestamp as stale history.
    const deliveredEvent = { ...event, receivedAtMs: now };
    try {
      await this.col.insertOne(stampVersion({
        userId,
        platform: event.platform,
        eventId: event.id,
        event: deliveredEvent,
        atMs: event.atMs,
        atDate: new Date(event.atMs),
        receivedAt: new Date(now),
        expiresAt: new Date(now + EVENT_TTL_MS),
      }, COLLECTIONS.PLATFORM_EVENTS));
    } catch (err) {
      if (err && /** @type {any} */ (err).code === 11000) return false;
      throw err;
    }
    if (this.io) {
      /** @type {Array<Record<string, any>>} */
      let tokens = [];
      try {
        tokens = await this.overlayTokens.list(userId);
      } catch (err) {
        this._log("warn", { err: safeError(err) }, "platform event token lookup failed");
      }
      for (const token of tokens) {
        if (!token?.token || token.revokedAt) continue;
        this.io.to(`overlay:${token.token}`).emit(
          "overlay:platformEvent",
          deliveredEvent,
        );
      }
    }
    return true;
  }

  /**
   * Replay a short bounded window on socket connect/resync. Replayed is an
   * explicit presentation flag: rows remain visible but audio/engagement
   * effects in the web client skip them.
   * @param {string} userId
   */
  async recentForUser(userId) {
    const cutoff = new Date(this.now() - REPLAY_WINDOW_MS);
    const rows = await this.col
      .find(
        // Replay eligibility is based on when SC2 Tools received the event,
        // not the provider occurrence time. YouTube can surface a newly public
        // subscription whose publishedAt is already several minutes old.
        { userId, receivedAt: { $gte: cutoff } },
        { projection: { _id: 0, event: 1, receivedAt: 1 } },
      )
      .sort({ receivedAt: -1 })
      .limit(REPLAY_LIMIT)
      .toArray();
    return rows
      .reverse()
      .map((row) => {
        const event = sanitizeEvent(row.event, this.now());
        if (!event) return null;
        // New rows carry receivedAtMs in the immutable event payload. Read the
        // document column as a rolling-deploy fallback for rows written by an
        // older process during the preceding replay window.
        const storedReceivedAtMs = Number(row?.event?.receivedAtMs);
        const documentReceivedAtMs = new Date(row?.receivedAt || 0).getTime();
        const receivedAtMs = Number.isFinite(storedReceivedAtMs)
          && storedReceivedAtMs > 0
          ? Math.trunc(storedReceivedAtMs)
          : Number.isFinite(documentReceivedAtMs) && documentReceivedAtMs > 0
            ? Math.trunc(documentReceivedAtMs)
            : event.atMs;
        return { ...event, receivedAtMs, replayed: true };
      })
      .filter(Boolean);
  }

  /** @param {'warn'|'info'|'error'} level @param {Record<string, any>} fields @param {string} message */
  _log(level, fields, message) {
    try {
      if (this.logger && typeof this.logger[level] === "function") {
        this.logger[level](fields, message);
      }
    } catch {
      /* logging is never part of delivery correctness */
    }
  }
}

/** @param {any} value @param {number} nowMs */
function sanitizeEvent(value, nowMs) {
  if (!value || typeof value !== "object") return null;
  const platform = String(value.platform || "");
  const kind = String(value.kind || "");
  const id = String(value.id || "").trim();
  if (!PLATFORMS.has(platform) || !KINDS.has(kind) || !id || id.length > 240) {
    return null;
  }
  const rawAt = Number(value.atMs);
  const atMs = Number.isFinite(rawAt)
    && rawAt >= nowMs - EVENT_TTL_MS
    && rawAt <= nowMs + 2 * 60 * 1000
    ? Math.trunc(rawAt)
    : nowMs;
  return {
    platform,
    id,
    kind,
    user: String(value.user || "Viewer").trim().slice(0, 120) || "Viewer",
    detail: String(value.detail || "").trim().slice(0, 300),
    ...(value.amount ? { amount: String(value.amount).slice(0, 100) } : {}),
    atMs,
    ...(value.official === true ? { official: true } : {}),
    ...(value.replayed === true ? { replayed: true } : {}),
    ...(typeof value.updateKey === "string" && value.updateKey
      ? { updateKey: value.updateKey.slice(0, 240) }
      : {}),
    ...(Number.isFinite(Number(value.updateVersion))
      ? { updateVersion: Math.max(0, Math.trunc(Number(value.updateVersion))) }
      : {}),
    ...(typeof value.dedupeKey === "string" && value.dedupeKey
      ? { dedupeKey: value.dedupeKey.slice(0, 240) }
      : {}),
    ...(Number.isFinite(Number(value.dedupeWindowMs))
      ? {
        dedupeWindowMs: Math.max(
          0,
          Math.min(10 * 60 * 1000, Math.trunc(Number(value.dedupeWindowMs))),
        ),
      }
      : {}),
  };
}

/** @param {unknown} err */
function safeError(err) {
  return err instanceof Error ? err.name : "unknown";
}

module.exports = {
  PlatformEventsService,
  sanitizeEvent,
  EVENT_TTL_MS,
  REPLAY_WINDOW_MS,
  REPLAY_LIMIT,
};
