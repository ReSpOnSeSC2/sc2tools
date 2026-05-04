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
}

module.exports = { UsersService };
