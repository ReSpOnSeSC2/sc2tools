"use strict";

const { createHash } = require("crypto");
const { OverlayTokenWrites } = require("./overlayTokenWrites");
const { OverlayTokenRotation, replacementTargets } = require("./overlayTokenRotation");
const { COLLECTIONS } = require("../config/constants");
const { randomToken } = require("../util/hash");
const { stampVersion } = require("../db/schemaVersioning");
const { validateOverlayProfile, defaultOverlayProfile, overlayProfileForRead } = require("../validation/overlayProfile");

/** @param {unknown} value */
const profileRevision = value => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

const DEFAULT_WIDGETS = Object.freeze([
  "opponent",
  "match-result",
  "post-game",
  "mmr-delta",
  "streak",
  "cheese",
  "rematch",
  "rival",
  "rank",
  "meta",
  "topbuilds",
  "fav-opening",
  "best-answer",
  "scouting",
  "session",
]);

/**
 * Every widget id the toggle endpoint will accept. Kept separate from
 * `DEFAULT_WIDGETS` (the set new tokens start with) so opt-in widgets
 * like the build randomizer are togglable without being on by default
 * for every streamer.
 */
const KNOWN_WIDGETS = Object.freeze([
  ...DEFAULT_WIDGETS,
  "randomizer",
  "multichat",
  // Stream Studio family — opt-in, driven by the multichat studio
  // state (Stream Dock) rather than game payloads.
  "chat-highlight",
  "chat-poll",
  "chat-alerts",
  "stream-goals",
  "session-recap",
  "stream-scene",
  "chat-oracle",
  "supporter-wall",
  "clip-flag",
  "lower-third",
  "stats-ticker",
  "countdown-timer",
  "build-profile",
  "series",
]);

const RESOLVE_CACHE_TTL_MS = 10_000;
const RESOLVE_CACHE_MAX = 256;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const LAST_SEEN_WRITE_MAX = 512;
const LAST_SEEN_RETENTION_MS = LAST_SEEN_WRITE_INTERVAL_MS * 2;
const RESOLVE_INFLIGHT_MAX = 16;
const OVERLAY_TOKEN_INPUT_MAX = 512;

/**
 * Overlay tokens are bearer tokens for the public OBS overlay route.
 * Each user can mint multiple (test/live/streamer-friend), revoke
 * individually. The token IS the auth — there's no Clerk session on
 * the OBS Browser Source.
 *
 * Storage shape:
 *   { token, userId, label, createdAt, lastSeenAt, revokedAt,
 *     enabledWidgets: string[] }
 */
class OverlayTokensService {
  /** @param {Pick<import('../db/connect').DbContext, "overlayTokens"> & Partial<import('../db/connect').DbContext>} db
   * @param {{onRotationStarted?:(token:string)=>void}} [opts] */
  constructor(db, opts = {}) {
    this.db = db;
    this.writes = new OverlayTokenWrites(token => this.resolve(token));
    this.rotation = new OverlayTokenRotation(/** @type {import('../db/connect').DbContext} */ (db), this, opts);
    /** @type {Map<string, {expiresAt: number, value: {userId: string, label: string, enabledWidgets: string[],profile:ReturnType<typeof overlayProfileForRead>,profileRevision:number}}>} */
    this.resolveCache = new Map();
    /** @type {Map<string, number>} */
    this.lastSeenWrites = new Map();
    /** @type {Map<string, Promise<{userId: string, label: string, enabledWidgets: string[],profile:ReturnType<typeof overlayProfileForRead>,profileRevision:number} | null>>} */
    this.resolveInflight = new Map();
    /** @type {WeakSet<Promise<any>>} */
    this.invalidatedInflight = new WeakSet();
    /** Profile edits require retry, rather than declaring a valid token revoked.
     * @type {WeakSet<Promise<any>>} */
    this.profileChangedInflight = new WeakSet();
  }

  /**
   * Cache cardinalities only. Token hashes, user ids, labels, and widget
   * configuration values are intentionally excluded.
   */
  capacitySnapshot() {
    return {
      resolveCacheEntries: this.resolveCache.size,
      lastSeenWriteEntries: this.lastSeenWrites.size,
      resolveInflight: this.resolveInflight.size,
      maxResolveCacheEntries: RESOLVE_CACHE_MAX,
      maxLastSeenWriteEntries: LAST_SEEN_WRITE_MAX,
      maxResolveInflight: RESOLVE_INFLIGHT_MAX,
    };
  }

  /**
   * @param {string} userId
   * @param {string} label
   */
  async create(userId, label) {
    const token = randomToken(24);
    const now = new Date();
    await this.db.overlayTokens.insertOne(
      stampVersion(
        {
          token,
          userId,
          label: label || "Default",
          createdAt: now,
          lastSeenAt: null,
          revokedAt: null,
          enabledWidgets: [...DEFAULT_WIDGETS],
          profile: defaultOverlayProfile(),
          profileRevision: 0,
        },
        COLLECTIONS.OVERLAY_TOKENS,
      ),
    );
    return { token, label, createdAt: now, enabledWidgets: [...DEFAULT_WIDGETS], profile: defaultOverlayProfile(), profileRevision: 0 };
  }

  /**
   * @param {string} userId
   * @returns {Promise<Array<{
   *   token: string,
   *   label: string,
   *   createdAt: Date,
   *   lastSeenAt?: Date|null,
   *   revokedAt?: Date|null,
   *   enabledWidgets: string[],
   * }>>}
   */
  async list(userId) {
    // Driver rows are WithId<Document>, and the object spread below
    // drops the index signature — treat rows as loose docs and let the
    // declared @returns carry the known shape.
    const items = /** @type {Array<any>} */ (
      await this.db.overlayTokens
        .find({ userId }, { projection: { _id: 0 } })
        .sort({ createdAt: -1 })
        .toArray()
    );
    // Backfill default widgets for tokens minted before the toggle
    // shipped — keeps the UI stable without a one-shot migration.
    const ready = new Set(items.filter(it => !it._rotationPending).map(it => it.token));
    return items.filter(it => !it._rotationPending).map(it => ({
      token: it.token, label: it.label, createdAt: it.createdAt,
      lastSeenAt: it.lastSeenAt ?? null, revokedAt: it.revokedAt ?? null,
      enabledWidgets: Array.isArray(it.enabledWidgets) ? it.enabledWidgets : [...DEFAULT_WIDGETS],
      profile: overlayProfileForRead(it.profile), profileRevision: profileRevision(it.profileRevision),
      ...(it._rotation ? it._rotation.state === "complete" && ready.has(it._rotation.to)
        ? { replacedBy: it._rotation.to } : { rotationPending: true } : {}),
    }));
  }

  /** @param {string} token */
  async resolve(token) {
    if (typeof token !== "string" || token.length > OVERLAY_TOKEN_INPUT_MAX) {
      return null;
    }
    const cacheKey = tokenCacheKey(token);
    const cached = this.resolveCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      this.resolveCache.delete(cacheKey);
      this.resolveCache.set(cacheKey, cached);
      this._touchLastSeen(token, cacheKey);
      return cached.value;
    }
    this.resolveCache.delete(cacheKey);
    const existing = this.resolveInflight.get(cacheKey);
    if (existing) return existing;
    if (this.resolveInflight.size >= RESOLVE_INFLIGHT_MAX) {
      const err = new Error("overlay_token_resolve_busy");
      /** @type {any} */ (err).code = "overlay_token_resolve_busy";
      /** @type {any} */ (err).status = 503;
      /** @type {any} */ (err).retryAfterSec = 1;
      throw err;
    }
    const pending = this.db.overlayTokens
      .findOne({ token, revokedAt: null })
      .then((row) => {
        if (!row || row._rotationPending || row._rotation) return null;
        // Revocation/widget mutation removes the owning in-flight entry. A
        // lookup that was already awaiting Mongo must not return its stale
        // pre-mutation value to socket or HTTP waiters afterward.
        if (
          this.resolveInflight.get(cacheKey) !== pending
          || this.invalidatedInflight.has(pending)
        ) {
          if (this.profileChangedInflight.has(pending)) {
            throw Object.assign(new Error("overlay_token_resolve_busy"), { code: "overlay_token_resolve_busy", status: 503, retryAfterSec: 1 });
          }
          return null;
        }
        const value = {
          userId: String(row.userId),
          label: String(row.label || ""),
          enabledWidgets: Array.isArray(row.enabledWidgets)
            ? row.enabledWidgets
            : [...DEFAULT_WIDGETS],
          profile: overlayProfileForRead(row.profile),
          profileRevision: profileRevision(row.profileRevision),
        };
        if (this.resolveInflight.get(cacheKey) === pending) {
          this.resolveCache.set(cacheKey, {
            expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS,
            value,
          });
          this._pruneResolveCache();
          this._touchLastSeen(token, cacheKey);
        }
        return value;
      })
      .finally(() => {
        if (this.resolveInflight.get(cacheKey) === pending) {
          this.resolveInflight.delete(cacheKey);
        }
      });
    this.resolveInflight.set(cacheKey, pending);
    return pending;
  }

  /**
   * @param {string} userId
   * @param {string} token
   * @returns {Promise<boolean>} whether the token belonged to this user
   */
  async revoke(userId, token) {
    const result = await this.db.overlayTokens.updateOne(
      { userId, token, "_rotation.state": { $ne: "pending" } },
      { $set: { revokedAt: new Date() } },
    );
    const cacheKey = tokenCacheKey(token);
    this.resolveCache.delete(cacheKey);
    this.lastSeenWrites.delete(cacheKey);
    const pending = this.resolveInflight.get(cacheKey);
    if (pending) this.invalidatedInflight.add(pending);
    return Number(result?.matchedCount || 0) > 0;
  }

  /**
   * Toggle a widget on or off for a specific overlay token.
   *
   * @param {string} userId
   * @param {string} token
   * @param {string} widget
   * @param {boolean} enabled
   */
  async setWidgetEnabled(userId, token, widget, enabled) {
    if (!KNOWN_WIDGETS.includes(widget)) {
      const err = new Error("unknown_widget");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    const op = /** @type {any} */ (
      enabled
        ? { $addToSet: { enabledWidgets: widget } }
        : { $pull: { enabledWidgets: widget } }
    );
    const changed = await this.db.overlayTokens.updateOne({ userId, token, revokedAt: null, _rotation: { $exists: false }, _rotationPending: { $ne: true } }, op);
    if (!changed.matchedCount) throw Object.assign(new Error("overlay_token_unavailable"), { status: 409, code: "overlay_token_unavailable" });
    const cacheKey = tokenCacheKey(token);
    this.resolveCache.delete(cacheKey);
    const pending = this.resolveInflight.get(cacheKey);
    if (pending) this.invalidatedInflight.add(pending);
    const row = await this.db.overlayTokens.findOne(
      { userId, token },
      { projection: { _id: 0, enabledWidgets: 1 } },
    );
    return {
      enabledWidgets: Array.isArray(row?.enabledWidgets)
        ? row.enabledWidgets
        : [...DEFAULT_WIDGETS],
    };
  }

  /** Replace one owned active token's allowlisted widget selection.
   * @param {string} userId @param {string} token
   * @param {unknown} enabled @param {unknown} [expectedEnabled]
   */
  async setEnabledWidgets(userId, token, enabled, expectedEnabled) {
    const widgets = widgetSelection(enabled);
    const match = /** @type {any} */ ({ userId, token, revokedAt: null, _rotation: { $exists: false }, _rotationPending: { $ne: true } });
    if (expectedEnabled !== undefined) {
      const expected = widgetSelection(expectedEnabled);
      const sameDefaults = expected.length === DEFAULT_WIDGETS.length && DEFAULT_WIDGETS.every(id => expected.includes(id));
      match.$or = [{ enabledWidgets: expected.length ? { $all: expected, $size: expected.length } : [] }, ...(sameDefaults ? [{ enabledWidgets: { $exists: false } }] : [])];
    }
    const row = await this.db.overlayTokens.findOneAndUpdate(match, { $set: { enabledWidgets: widgets } }, { returnDocument: "after", projection: { _id: 0, enabledWidgets: 1 } });
    if (!row) {
      const exists = await this.tokenBelongsToUser(userId, token);
      const err = /** @type {Error & {status: number, code: string}} */ (new Error(exists ? "widget_selection_changed" : "not_found"));
      err.status = exists ? 409 : 404; err.code = err.message; throw err;
    }
    const cacheKey = tokenCacheKey(token);
    this.resolveCache.delete(cacheKey);
    const pending = this.resolveInflight.get(cacheKey);
    if (pending) this.invalidatedInflight.add(pending);
    return { enabledWidgets: row.enabledWidgets };
  }

  /** Owner-scoped profile CAS never replaces widget selection or credentials.
   * @param {string} userId @param {string} token @param {unknown} raw
   * @param {unknown} expectedRevision */
  async setProfile(userId, token, raw, expectedRevision) {
    const profile = validateOverlayProfile(raw);
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0 || Number(expectedRevision) >= Number.MAX_SAFE_INTEGER) {
      throw Object.assign(new Error("Use the current overlay profile revision."), { status: 400, code: "invalid_overlay_profile_revision" });
    }
    const revision = Number(expectedRevision);
    const row = await this.db.overlayTokens.findOneAndUpdate({ userId, token, revokedAt: null, _rotation: { $exists: false }, _rotationPending: { $ne: true },
      $or: [{ profileRevision: revision }, ...(revision === 0 ? [{ profileRevision: { $exists: false } }] : [])],
    }, { $set: { profile, profileRevision: revision + 1 } }, { returnDocument: "after", projection: { _id: 0, profile: 1, profileRevision: 1 } });
    if (!row) {
      const owned = await this.tokenBelongsToUser(userId, token);
      throw Object.assign(new Error(owned ? "overlay_profile_changed" : "not_found"), { status: owned ? 409 : 404, code: owned ? "overlay_profile_changed" : "not_found" });
    }
    const cacheKey = tokenCacheKey(token);
    this.resolveCache.delete(cacheKey);
    const pending = this.resolveInflight.get(cacheKey);
    if (pending) { this.invalidatedInflight.add(pending); this.profileChangedInflight.add(pending); }
    return { profile: overlayProfileForRead(row.profile), profileRevision: profileRevision(row.profileRevision) };
  }

  /**
   * Resolve userId from token without bumping `lastSeenAt`. Used by
   * the agent's overlay-events POST.
   *
   * @param {string} userId
   * @param {string} token
   */
  async tokenBelongsToUser(userId, token) {
    const row = await this.db.overlayTokens.findOne({
      userId,
      token,
      revokedAt: null, _rotation: { $exists: false }, _rotationPending: { $ne: true },
    });
    return Boolean(row);
  }

  /** Bounded device-heartbeat catch-up; private device auth is required by
   * the caller. Only ready terminal targets are included; agents fetch the full
   * owner config before resolving chains or changing a generated source.
   * @param {string} userId */
  async replacementReceipts(userId) {
    const rows = await this.db.overlayTokens.find({ userId, "_rotation.state": "complete" }, { projection: { token: 1, revokedAt: 1, _rotationPending: 1, _rotation: 1 }, maxTimeMS: 1000 }).sort({ "_rotation.startedAt": -1 }).limit(32).toArray();
    if (!rows.length) return [];
    const targets = await replacementTargets(this.db.overlayTokens, userId, new Map(rows.map(row => [String(row.token), String(row._rotation.to)])), rows);
    return [...targets].flatMap(([from, target]) => target.token ? [{ from, to: target.token }] : []);
  }

  /** Never exposes a replacement credential to its former bearer.
   * @param {string} token */
  async isReplaced(token) {
    if (typeof token !== "string" || token.length > OVERLAY_TOKEN_INPUT_MAX) return false;
    return Boolean(await this.db.overlayTokens.findOne({ token, _rotation: { $exists: true } }, { projection: { _id: 1 } }));
  }

  /** @param {string} token @param {boolean} [retry] */
  invalidate(token, retry = false) {
    const key = tokenCacheKey(token); this.resolveCache.delete(key); this.lastSeenWrites.delete(key);
    const pending = this.resolveInflight.get(key);
    if (pending) { this.invalidatedInflight.add(pending); if (retry) this.profileChangedInflight.add(pending); }
  }

  /** @template T @param {string} token @param {()=>Promise<T>} work */
  withWrite(token, work) { return this.writes.run(token, work); }
  /** @param {string} userId @param {string} token */
  rotate(userId, token) { return this.rotation.rotate(userId, token); }

  /** @param {string} userId @param {string} token @param {unknown} label */
  async rename(userId, token, label) {
    if (typeof label !== "string" || !label.trim() || label.length > 60) throw Object.assign(new Error("invalid_overlay_label"), { status: 400, code: "invalid_overlay_label" });
    const changed = await this.db.overlayTokens.updateOne({ userId, token, revokedAt: null, _rotation: { $exists: false }, _rotationPending: { $ne: true } }, { $set: { label: label.trim() } });
    if (!changed.matchedCount) throw Object.assign(new Error("overlay_token_unavailable"), { status: 409, code: "overlay_token_unavailable" });
    this.invalidate(token, true);
    return { label: label.trim() };
  }

  /** @param {string} token @param {string} cacheKey */
  _touchLastSeen(token, cacheKey) {
    const now = Date.now();
    this._pruneLastSeenWrites(now);
    const lastWrite = this.lastSeenWrites.get(cacheKey) || 0;
    if (now - lastWrite < LAST_SEEN_WRITE_INTERVAL_MS) return;
    this.lastSeenWrites.delete(cacheKey);
    this.lastSeenWrites.set(cacheKey, now);
    this._pruneLastSeenWrites(now);
    this.db.overlayTokens
      .updateOne({ token, revokedAt: null }, { $set: { lastSeenAt: new Date(now) } })
      .catch(() => {
        // Let the next request retry instead of suppressing the heartbeat for
        // a full minute after a transient Mongo error.
        if (this.lastSeenWrites.get(cacheKey) === now) {
          this.lastSeenWrites.delete(cacheKey);
        }
      });
  }

  _pruneResolveCache() {
    const now = Date.now();
    for (const [key, cached] of this.resolveCache) {
      if (cached.expiresAt <= now) this.resolveCache.delete(key);
    }
    while (this.resolveCache.size > RESOLVE_CACHE_MAX) {
      const oldest = this.resolveCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.resolveCache.delete(oldest);
      this.lastSeenWrites.delete(oldest);
    }
    this._pruneLastSeenWrites(now);
  }

  /** @param {number} now */
  _pruneLastSeenWrites(now) {
    for (const [key, lastWrite] of this.lastSeenWrites) {
      if (now - lastWrite >= LAST_SEEN_RETENTION_MS) {
        this.lastSeenWrites.delete(key);
      }
    }
    while (this.lastSeenWrites.size > LAST_SEEN_WRITE_MAX) {
      const oldest = this.lastSeenWrites.keys().next().value;
      if (typeof oldest !== "string") break;
      this.lastSeenWrites.delete(oldest);
    }
  }
}

/**
 * Keep raw bearer credentials out of long-lived in-process cache keys.
 * @param {string} token
 * @returns {string}
 */
function tokenCacheKey(token) {
  return createHash("sha256").update(String(token)).digest("base64url");
}

/** @param {unknown} value @returns {string[]} */
function widgetSelection(value) {
  if (!Array.isArray(value) || value.length > KNOWN_WIDGETS.length || value.some(id => typeof id !== "string" || !KNOWN_WIDGETS.includes(id)) || new Set(value).size !== value.length) {
    const err = /** @type {Error & {status: number, code: string}} */ (new Error("invalid_widget_selection"));
    err.status = 400; err.code = err.message; throw err;
  }
  return [...value].sort();
}

module.exports = {
  OverlayTokensService,
  DEFAULT_WIDGETS,
  KNOWN_WIDGETS,
  RESOLVE_CACHE_TTL_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  LAST_SEEN_WRITE_MAX,
  RESOLVE_INFLIGHT_MAX,
};
