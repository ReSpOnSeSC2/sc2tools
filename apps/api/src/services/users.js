"use strict";

const crypto = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * User service. The `users` collection maps Clerk user ids → our
 * internal user ids (stable UUIDs). Internal ids decouple our DB from
 * the auth provider, so swapping Clerk later is a one-table migration.
 */
class UsersService {
  /** @param {{users: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Idempotent: create the user record on first sight, return existing
   * record on subsequent calls.
   *
   * @param {string} clerkUserId
   * @returns {Promise<{userId: string, clerkUserId: string}>}
   */
  async ensureFromClerk(clerkUserId) {
    if (!clerkUserId) throw new Error("clerkUserId required");
    const existing = await this.db.users.findOne({ clerkUserId });
    if (existing) {
      return { userId: existing.userId, clerkUserId };
    }
    const userId = crypto.randomUUID();
    const now = new Date();
    const doc = stampVersion(
      {
        userId,
        clerkUserId,
        createdAt: now,
        lastSeenAt: now,
      },
      COLLECTIONS.USERS,
    );
    try {
      await this.db.users.insertOne(doc);
    } catch (err) {
      // Race: a concurrent request inserted first. Re-read.
      const code = /** @type {any} */ (err)?.code;
      if (code === 11000) {
        const again = await this.db.users.findOne({ clerkUserId });
        if (again) return { userId: again.userId, clerkUserId };
      }
      throw err;
    }
    return { userId, clerkUserId };
  }

  /**
   * Bump `lastSeenAt`. Cheap, fire-and-forget; failures are non-fatal.
   *
   * @param {string} userId
   */
  async touch(userId) {
    await this.db.users.updateOne(
      { userId },
      { $set: { lastSeenAt: new Date() } },
    );
  }

  /**
   * Read the lightweight account summary used by /v1/me — userId,
   * clerkUserId (when known), and the cached email. We project narrowly
   * so the row doesn't drag the entire profile into memory on every page
   * load.
   *
   * @param {string} userId
   * @returns {Promise<{userId: string, clerkUserId: string|null, email: string|null}>}
   */
  async getSummary(userId) {
    const doc = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, userId: 1, clerkUserId: 1, email: 1 } },
    );
    if (!doc) return { userId, clerkUserId: null, email: null };
    return {
      userId: doc.userId,
      clerkUserId: typeof doc.clerkUserId === "string" ? doc.clerkUserId : null,
      email: typeof doc.email === "string" && doc.email.length > 0
        ? doc.email
        : null,
    };
  }

  /**
   * Cache an email on the user record. Idempotent — only writes when the
   * value actually changes, so we don't churn `_schemaVersion` or
   * `lastSeenAt` on no-op refreshes.
   *
   * @param {string} userId
   * @param {string} email
   */
  async setEmail(userId, email) {
    if (typeof email !== "string" || email.length === 0) return;
    await this.db.users.updateOne(
      { userId, email: { $ne: email } },
      { $set: { email, emailUpdatedAt: new Date() } },
    );
  }

  /**
   * Webhook entrypoint: upsert email by Clerk user id. The user row may
   * not exist yet if the webhook lands before the user's first API call,
   * so we insert a stub on miss using the same shape `ensureFromClerk`
   * produces. Returns true when an email was written or a stub created.
   *
   * @param {string} clerkUserId
   * @param {string|null} email
   * @returns {Promise<boolean>}
   */
  async upsertFromWebhook(clerkUserId, email) {
    if (!clerkUserId) return false;
    const now = new Date();
    /** @type {Record<string, unknown>} */
    const set = { lastSeenAt: now };
    if (typeof email === "string" && email.length > 0) {
      set.email = email;
      set.emailUpdatedAt = now;
    }
    /** @type {Record<string, unknown>} */
    const setOnInsert = {
      userId: crypto.randomUUID(),
      clerkUserId,
      createdAt: now,
    };
    stampVersion(setOnInsert, COLLECTIONS.USERS);
    const res = await this.db.users.updateOne(
      { clerkUserId },
      { $set: set, $setOnInsert: setOnInsert },
      { upsert: true },
    );
    return res.modifiedCount > 0 || res.upsertedCount > 0;
  }

  /**
   * Read the public-facing profile fields. Returns an empty object
   * when no fields have been set, never null, so callers can spread
   * the result without a null check.
   *
   * ``pulseIds`` is the canonical list. ``pulseId`` is mirrored from
   * ``pulseIds[0]`` (or the legacy single-string field on docs that
   * pre-date the migration) so existing read-paths — the session
   * widget's MMR fallback, the agent's player-handle resolver — keep
   * working without a separate backfill.
   *
   * @param {string} userId
   * @returns {Promise<{
   *   battleTag?: string,
   *   pulseId?: string,
   *   pulseIds?: string[],
   *   region?: string,
   *   preferredRace?: string,
   *   displayName?: string,
   *   lastKnownMmr?: number,
   *   lastKnownMmrAt?: string,
   *   lastKnownMmrRegion?: string,
   * }>}
   */
  async getProfile(userId) {
    const doc = await this.db.users.findOne(
      { userId },
      {
        projection: {
          _id: 0,
          battleTag: 1,
          pulseId: 1,
          pulseIds: 1,
          region: 1,
          preferredRace: 1,
          displayName: 1,
          lastKnownMmr: 1,
          lastKnownMmrAt: 1,
          lastKnownMmrRegion: 1,
        },
      },
    );
    if (!doc) return {};
    /** @type {Record<string, string|number|string[]>} */
    const out = {};
    for (const k of [
      "battleTag",
      "region",
      "preferredRace",
      "displayName",
      "lastKnownMmrAt",
      "lastKnownMmrRegion",
    ]) {
      const v = doc[k];
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    // Pulse IDs: prefer the array; fall back to the legacy single
    // field. We always emit ``pulseId`` (the first entry) so callers
    // that were written against the pre-migration shape still see a
    // value.
    const ids = normalisePulseIdList(
      Array.isArray(doc.pulseIds)
        ? doc.pulseIds
        : typeof doc.pulseId === "string"
          ? [doc.pulseId]
          : [],
    );
    if (ids.length > 0) {
      out.pulseIds = ids;
      out.pulseId = ids[0];
    }
    // ``lastKnownMmr`` is the only numeric field — surface it as a
    // number so the session widget's tier-comparison code can use it
    // without parsing.
    if (typeof doc.lastKnownMmr === "number" && Number.isFinite(doc.lastKnownMmr)) {
      out.lastKnownMmr = doc.lastKnownMmr;
    }
    return out;
  }

  /**
   * Append a single pulse identifier (toon handle or numeric SC2Pulse
   * character id) to the user's ``pulseIds`` array, dedup-aware. Used
   * by the games ingest path to auto-populate the array as the agent
   * forwards each replay's ``myToonHandle`` — streamers shouldn't have
   * to paste their own toon handle into Settings for the session
   * widget's SC2Pulse fallback to resolve their MMR.
   *
   * Idempotent: a no-op when the id is already present.
   * Skips clobbering the user's typed-in single-string ``pulseId`` —
   * if the array doesn't exist yet but the legacy field does, the
   * legacy value is preserved as the first entry of the new array.
   *
   * @param {string} userId
   * @param {string} pulseId
   * @returns {Promise<boolean>} true when the array changed.
   */
  async addPulseId(userId, pulseId) {
    if (typeof pulseId !== "string") return false;
    const trimmed = pulseId.trim();
    if (!trimmed || trimmed.length > 64) return false;
    const doc = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, pulseIds: 1, pulseId: 1 } },
    );
    if (!doc) return false;
    const current = normalisePulseIdList(
      Array.isArray(doc.pulseIds)
        ? doc.pulseIds
        : typeof doc.pulseId === "string"
          ? [doc.pulseId]
          : [],
    );
    if (current.includes(trimmed)) return false;
    if (current.length >= 20) return false;
    const next = current.concat(trimmed);
    /** @type {Record<string, any>} */
    const set = { pulseIds: next, pulseId: next[0] };
    stampVersion(set, COLLECTIONS.USERS);
    await this.db.users.updateOne({ userId }, { $set: set });
    return true;
  }

  /**
   * Read per-user preferences for a given type key (e.g. "misc", "voice").
   * Returns {} when not yet set.
   *
   * @param {string} userId
   * @param {string} type
   * @returns {Promise<Record<string, unknown>>}
   */
  async getPreferences(userId, type) {
    const doc = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, [`preferences.${type}`]: 1 } },
    );
    return (doc && doc.preferences && doc.preferences[type]) || {};
  }

  /**
   * Merge-replace the preferences sub-document for a given type key.
   * The entire sub-object is replaced atomically so stale keys don't
   * accumulate; callers should always send the full preferences object.
   *
   * @param {string} userId
   * @param {string} type
   * @param {Record<string, unknown>} prefs
   * @returns {Promise<Record<string, unknown>>}
   */
  async updatePreferences(userId, type, prefs) {
    await this.db.users.updateOne(
      { userId },
      { $set: { [`preferences.${type}`]: prefs } },
    );
    return prefs;
  }

  /**
   * Replace the profile block on the user record. Empty/missing
   * fields are unset on disk so the document doesn't accumulate
   * stale entries. The profile is the only writable surface — we
   * never let the client touch userId/clerkUserId/createdAt.
   *
   * The agent has its own narrower entry point for sticky-MMR pings
   * (``patchLastKnownMmr``) — it never sends the user-editable fields
   * (battleTag/pulseId/region/preferredRace/displayName), so the agent
   * can't accidentally clear what the streamer typed into Settings.
   *
   * @param {string} userId
   * @param {{
   *   battleTag?: string|null,
   *   pulseId?: string|null,
   *   region?: string|null,
   *   preferredRace?: string|null,
   *   displayName?: string|null,
   *   lastKnownMmr?: number|null,
   *   lastKnownMmrAt?: string|null,
   *   lastKnownMmrRegion?: string|null,
   * }} profile
   */
  async updateProfile(userId, profile) {
    const STRING_FIELDS = [
      "battleTag",
      "region",
      "preferredRace",
      "displayName",
      "lastKnownMmrAt",
      "lastKnownMmrRegion",
    ];
    /** @type {Record<string, any>} */
    const set = {};
    /** @type {Record<string, "">} */
    const unset = {};
    for (const k of STRING_FIELDS) {
      const raw = profile ? profile[/** @type {keyof typeof profile} */ (k)] : undefined;
      if (typeof raw === "string" && raw.trim().length > 0) {
        set[k] = raw.trim();
      } else {
        unset[k] = "";
      }
    }
    applyPulseIdsUpdate(profile, set, unset);
    // ``lastKnownMmr`` is numeric. Treat null/missing as "clear", a
    // valid integer in the [500, 9999] band as "set". Out-of-band
    // values are dropped on the floor (never set, never unset) so a
    // malformed agent ping can't clear a previously-good value.
    if (profile && Object.prototype.hasOwnProperty.call(profile, "lastKnownMmr")) {
      const raw = profile.lastKnownMmr;
      if (raw === null) {
        unset.lastKnownMmr = "";
      } else if (
        typeof raw === "number" &&
        Number.isInteger(raw) &&
        raw >= 500 &&
        raw <= 9999
      ) {
        set.lastKnownMmr = raw;
      }
    } else {
      unset.lastKnownMmr = "";
    }
    set.profileUpdatedAt = /** @type {any} */ (new Date());
    // Re-stamp the schema version on every write so a future bump of
    // USERS' currentVersion rolls existing docs forward as they're
    // touched, without a separate backfill.
    stampVersion(set, COLLECTIONS.USERS);
    /** @type {Record<string, any>} */
    const update = { $set: set };
    if (Object.keys(unset).length > 0) update.$unset = unset;
    await this.db.users.updateOne({ userId }, update);
    return this.getProfile(userId);
  }

  /**
   * Narrow agent-only entry for the sticky-MMR ping. Patches just the
   * three ``lastKnownMmr*`` fields without touching the user-editable
   * profile (battleTag/pulseId/region/...) — the agent must never be
   * able to clobber what the streamer typed into Settings.
   *
   * Idempotent on a no-op: if ``mmr`` matches the stored value we
   * skip the write entirely (saves a Mongo round-trip per replay
   * during a 13k-replay backfill).
   *
   * @param {string} userId
   * @param {{
   *   mmr: number,
   *   capturedAt?: string,
   *   region?: string,
   * }} update
   * @returns {Promise<boolean>} true when the document was actually written.
   */
  async patchLastKnownMmr(userId, update) {
    if (!update || typeof update !== "object") return false;
    const mmr = Number(update.mmr);
    if (!Number.isInteger(mmr) || mmr < 500 || mmr > 9999) return false;
    /** @type {Record<string, any>} */
    const set = { lastKnownMmr: mmr };
    if (typeof update.capturedAt === "string" && update.capturedAt) {
      set.lastKnownMmrAt = update.capturedAt.slice(0, 40);
    } else {
      set.lastKnownMmrAt = new Date().toISOString();
    }
    if (typeof update.region === "string" && update.region) {
      set.lastKnownMmrRegion = update.region.slice(0, 8);
    }
    // Skip the write if nothing changed — most replays in a backfill
    // produce the same MMR as the prior one, so the unconditional
    // updateOne would generate ~13k pointless writes during a
    // re-sync.
    const existing = await this.db.users.findOne(
      { userId },
      { projection: { _id: 0, lastKnownMmr: 1, lastKnownMmrRegion: 1 } },
    );
    if (
      existing &&
      existing.lastKnownMmr === mmr &&
      existing.lastKnownMmrRegion === set.lastKnownMmrRegion
    ) {
      return false;
    }
    stampVersion(set, COLLECTIONS.USERS);
    await this.db.users.updateOne({ userId }, { $set: set });
    return true;
  }
}

/**
 * Resolve the next ``pulseIds`` array from a partial profile update,
 * folding the legacy single-string ``pulseId`` field in when ``pulseIds``
 * was not supplied. Mutates the caller's ``set``/``unset`` accumulators
 * in place; mirrors the first id into the legacy ``pulseId`` field so
 * unmigrated read-paths keep resolving.
 *
 * @param {Record<string, unknown> | null | undefined} profile
 * @param {Record<string, any>} set
 * @param {Record<string, "">} unset
 */
function applyPulseIdsUpdate(profile, set, unset) {
  /** @type {string[]|null} */
  let nextPulseIds = null;
  if (profile && Object.prototype.hasOwnProperty.call(profile, "pulseIds")) {
    const raw = profile.pulseIds;
    if (Array.isArray(raw)) nextPulseIds = normalisePulseIdList(raw);
    else if (raw === null) nextPulseIds = [];
  } else if (profile && Object.prototype.hasOwnProperty.call(profile, "pulseId")) {
    const raw = profile.pulseId;
    nextPulseIds =
      typeof raw === "string" && raw.trim() ? [raw.trim()] : [];
  }
  if (nextPulseIds === null) return;
  if (nextPulseIds.length === 0) {
    unset.pulseIds = "";
    unset.pulseId = "";
  } else {
    set.pulseIds = nextPulseIds;
    set.pulseId = nextPulseIds[0];
  }
}

/**
 * Trim, dedupe, and bound-check an array of pulse identifiers. Strings
 * only; entries that survived after trimming and aren't already in the
 * accumulator are kept in input order. Capped at 20 to match the
 * profile schema's ``maxItems``.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalisePulseIdList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 64) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= 20) break;
  }
  return out;
}

module.exports = { UsersService };
