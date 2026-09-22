"use strict";

const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const ACTIVITY_WINDOW_SECONDS = 180;
const SNAPSHOT_CACHE_MS = 10_000;
const VISITOR_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const QUERY_MAX_TIME_MS = 2_500;

/**
 * @typedef {{_id: string, identityKey: string, lastSeenAt: Date, expiresAt: Date}} SitePresenceDoc
 * @typedef {{agentDownloads: number|null, activeAgents: number|null, activeUsers: number|null, generatedAt: string, activityWindowSeconds: number}} SiteStatsSnapshot
 */

/** Public totals, using persisted download events, agent heartbeats and web presence. */
class SiteStatsService {
  /**
   * @param {import('../db/connect').DbContext} db
   * @param {{secret: Buffer|string, now?: () => number, cacheMs?: number, logger?: {warn: Function}}} opts
   */
  constructor(db, opts) {
    this.db = db;
    this.secret = opts.secret;
    this.now = opts.now || Date.now;
    this.cacheMs = opts.cacheMs ?? SNAPSHOT_CACHE_MS;
    this.logger = opts.logger || null;
    /** @type {SiteStatsSnapshot|null} */
    this.snapshot = null;
    this.snapshotExpiresAt = 0;
    /** @type {Promise<SiteStatsSnapshot>|null} */
    this.pendingSnapshot = null;
  }

  /** Concurrent visitors share one bounded aggregate read per cache window. */
  async counts() {
    if (this.snapshot && this.now() < this.snapshotExpiresAt) return this.snapshot;
    if (this.pendingSnapshot) return this.pendingSnapshot;
    this.pendingSnapshot = this.readCounts();
    try {
      this.snapshot = await this.pendingSnapshot;
      this.snapshotExpiresAt = this.now() + this.cacheMs;
      return this.snapshot;
    } finally {
      this.pendingSnapshot = null;
    }
  }

  /** @returns {Promise<SiteStatsSnapshot>} */
  async readCounts() {
    const now = new Date(this.now());
    const recent = new Date(now.getTime() - ACTIVITY_WINDOW_SECONDS * 1000);
    const [agentDownloads, activeAgents, activeUsers] = await Promise.all([
      this.readMetric("agentDownloads", () => this.db.adminEvents.countDocuments(
        { type: "agent_download" }, { maxTimeMS: QUERY_MAX_TIME_MS },
      )),
      this.readMetric("activeAgents", () => this.db.deviceTokens.countDocuments({
        revokedAt: null,
        lastSeenAt: { $gte: recent, $lte: now },
      }, { maxTimeMS: QUERY_MAX_TIME_MS })),
      this.readMetric("activeUsers", async () => {
        const rows = await this.db.sitePresence.aggregate([
          { $match: { lastSeenAt: { $gte: recent, $lte: now }, expiresAt: { $gt: now } } },
          { $group: { _id: "$identityKey" } },
          { $count: "count" },
        ], { maxTimeMS: QUERY_MAX_TIME_MS }).toArray();
        return rows.length ? rows[0].count : 0;
      }),
    ]);
    return {
      agentDownloads, activeAgents, activeUsers,
      generatedAt: now.toISOString(),
      activityWindowSeconds: ACTIVITY_WINDOW_SECONDS,
    };
  }

  /** A failed source is unknown; a successful empty query really is zero.
   * @param {string} metric
   * @param {() => Promise<number>} read
   */
  async readMetric(metric, read) {
    try {
      const value = await read();
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_count");
      return value;
    } catch (err) {
      this.logger?.warn({ err, metric }, "site_stats_unavailable");
      return null;
    }
  }

  /**
   * A browser keeps its opaque signed token in a first-party HttpOnly cookie.
   * Replacing identityKey on the same row handles both sign-in and sign-out;
   * grouping by it counts one signed-in account across browsers/devices.
   * Nothing here stores raw account IDs, addresses, user agents or page paths.
   * @param {string|undefined} visitorToken
   * @param {string|null} clerkUserId
   */
  async recordPresence(visitorToken, clerkUserId = null) {
    const now = this.now();
    let token = visitorToken || this.issueVisitorToken(now);
    // Renew an active browser's signature without changing its identity.
    // The short grace period cannot overlap an old row beyond its TTL.
    const visitorId = this.parseVisitorToken(token, now - ACTIVITY_WINDOW_SECONDS * 1000);
    if (!visitorId) throw presenceError(400, "invalid_presence_token");
    if (Number(token.split(".")[2]) <= now + ACTIVITY_WINDOW_SECONDS * 1000) {
      token = this.issueVisitorToken(now, visitorId);
    }
    const browserKey = this.hash(`browser:${visitorId}`);
    const identityKey = clerkUserId ? this.hash(`account:${clerkUserId}`) : browserKey;
    const update = { $set: {
      identityKey,
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + ACTIVITY_WINDOW_SECONDS * 1000),
    } };
    try {
      await this.db.sitePresence.updateOne({ _id: browserKey }, update, { upsert: true });
    } catch (err) {
      // Simultaneous tabs can race the first upsert for the same token.
      if (err && typeof err === "object" && "code" in err && err.code === 11000) {
        await this.db.sitePresence.updateOne({ _id: browserKey }, update);
      } else {
        throw err;
      }
    }
    return { visitorToken: token };
  }

  /** @param {number} now @param {string} [visitorId] */
  issueVisitorToken(now, visitorId = randomBytes(32).toString("base64url")) {
    const payload = `v1.${visitorId}.${now + VISITOR_TOKEN_LIFETIME_MS}`;
    return `${payload}.${this.hash(`token:${payload}`)}`;
  }

  /** @param {unknown} token @param {number} [now] @returns {string|null} */
  parseVisitorToken(token, now = this.now()) {
    if (typeof token !== "string" || token.length > 160) return null;
    const parts = /^v1\.([A-Za-z0-9_-]{43})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!parts || Number(parts[2]) <= now) return null;
    const payload = token.slice(0, token.lastIndexOf("."));
    const expected = this.hash(`token:${payload}`);
    if (!timingSafeEqual(Buffer.from(parts[3]), Buffer.from(expected))) return null;
    return parts[1];
  }

  /** Domain separation keeps presence hashes distinct from other pepper uses.
   * @param {string} value
   */
  hash(value) {
    return createHmac("sha256", this.secret).update(`site-presence:${value}`).digest("base64url");
  }
}

/** @param {number} status @param {string} code */
function presenceError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

module.exports = { SiteStatsService, ACTIVITY_WINDOW_SECONDS, SNAPSHOT_CACHE_MS };
