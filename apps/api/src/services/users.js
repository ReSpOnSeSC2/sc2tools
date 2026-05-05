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
   * Read the public-facing profile fields. Returns an empty object
   * when no fields have been set, never null, so callers can spread
   * the result without a null check.
   *
   * @param {string} userId
   * @returns {Promise<{
   *   battleTag?: string,
   *   pulseId?: string,
   *   region?: string,
   *   preferredRace?: string,
   *   displayName?: string,
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
          region: 1,
          preferredRace: 1,
          displayName: 1,
        },
      },
    );
    if (!doc) return {};
    /** @type {Record<string, string>} */
    const out = {};
    for (const k of [
      "battleTag",
      "pulseId",
      "region",
      "preferredRace",
      "displayName",
    ]) {
      const v = doc[k];
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  }

  /**
   * Replace the profile block on the user record. Empty/missing
   * fields are unset on disk so the document doesn't accumulate
   * stale entries. The profile is the only writable surface — we
   * never let the client touch userId/clerkUserId/createdAt.
   *
   * @param {string} userId
   * @param {{
   *   battleTag?: string|null,
   *   pulseId?: string|null,
   *   region?: string|null,
   *   preferredRace?: string|null,
   *   displayName?: string|null,
   * }} profile
   */
  async updateProfile(userId, profile) {
    const FIELDS = [
      "battleTag",
      "pulseId",
      "region",
      "preferredRace",
      "displayName",
    ];
    /** @type {Record<string, string>} */
    const set = {};
    /** @type {Record<string, "">} */
    const unset = {};
    for (const k of FIELDS) {
      const raw = profile ? profile[/** @type {keyof typeof profile} */ (k)] : undefined;
      if (typeof raw === "string" && raw.trim().length > 0) {
        set[k] = raw.trim();
      } else {
        unset[k] = "";
      }
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
}

module.exports = { UsersService };
