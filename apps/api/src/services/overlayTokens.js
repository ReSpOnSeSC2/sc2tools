"use strict";

const { COLLECTIONS } = require("../config/constants");
const { randomToken } = require("../util/hash");
const { stampVersion } = require("../db/schemaVersioning");

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
          enabledWidgets: [...DEFAULT_WIDGETS],
        },
        COLLECTIONS.OVERLAY_TOKENS,
      ),
    );
    return { token, label, createdAt: now, enabledWidgets: [...DEFAULT_WIDGETS] };
  }

  /**
   * @param {string} userId
   */
  async list(userId) {
    const items = await this.db.overlayTokens
      .find({ userId }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    // Backfill default widgets for tokens minted before the toggle
    // shipped — keeps the UI stable without a one-shot migration.
    return items.map((it) => ({
      ...it,
      enabledWidgets: Array.isArray(it.enabledWidgets)
        ? it.enabledWidgets
        : [...DEFAULT_WIDGETS],
    }));
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
    return {
      userId: row.userId,
      label: row.label,
      enabledWidgets: Array.isArray(row.enabledWidgets)
        ? row.enabledWidgets
        : [...DEFAULT_WIDGETS],
    };
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

  /**
   * Toggle a widget on or off for a specific overlay token.
   *
   * @param {string} userId
   * @param {string} token
   * @param {string} widget
   * @param {boolean} enabled
   */
  async setWidgetEnabled(userId, token, widget, enabled) {
    if (!DEFAULT_WIDGETS.includes(widget)) {
      const err = new Error("unknown_widget");
      /** @type {any} */ (err).status = 400;
      throw err;
    }
    const op = /** @type {any} */ (
      enabled
        ? { $addToSet: { enabledWidgets: widget } }
        : { $pull: { enabledWidgets: widget } }
    );
    await this.db.overlayTokens.updateOne({ userId, token }, op);
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
      revokedAt: null,
    });
    return Boolean(row);
  }
}

module.exports = { OverlayTokensService, DEFAULT_WIDGETS };
