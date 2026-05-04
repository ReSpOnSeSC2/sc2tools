"use strict";

const { COLLECTIONS } = require("../config/constants");
const { randomToken } = require("../util/hash");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Overlay tokens are bearer tokens for the public OBS overlay route.
 * Each user can mint multiple (test/live/streamer-friend), revoke
 * individually. The token IS the auth — there's no Clerk session on
 * the OBS Browser Source.
 *
 * Storage shape:
 *   { token, userId, label, createdAt, lastSeenAt, revokedAt }
 */
class OverlayTokensService {
  /** @param {{overlayTokens: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
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
        },
        COLLECTIONS.OVERLAY_TOKENS,
      ),
    );
    return { token, label, createdAt: now };
  }

  /**
   * @param {string} userId
   */
  async list(userId) {
    return this.db.overlayTokens
      .find({ userId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
  }

  /** @param {string} token */
  async resolve(token) {
    const row = await this.db.overlayTokens.findOne({
      token,
      revokedAt: null,
    });
    if (!row) return null;
    this.db.overlayTokens
      .updateOne({ token }, { $set: { lastSeenAt: new Date() } })
      .catch(() => {});
    return { userId: row.userId, label: row.label };
  }

  /**
   * @param {string} userId
   * @param {string} token
   */
  async revoke(userId, token) {
    await this.db.overlayTokens.updateOne(
      { userId, token },
      { $set: { revokedAt: new Date() } },
    );
  }
}

module.exports = { OverlayTokensService };
