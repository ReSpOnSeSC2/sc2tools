"use strict";

const { LIMITS } = require("../config/constants");

/**
 * Games service. One document per (userId, gameId). Idempotent on
 * insert: if the agent re-uploads after a retry, we update existing
 * record rather than duplicate.
 */
class GamesService {
  /** @param {{games: import('mongodb').Collection}} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Insert or update a game record. Returns true if it was new.
   *
   * @param {string} userId
   * @param {{gameId: string, date: string | Date} & Record<string, unknown>} game
   * @returns {Promise<boolean>}
   */
  async upsert(userId, game) {
    if (!game || !game.gameId) throw new Error("gameId required");
    const date = game.date instanceof Date ? game.date : new Date(game.date);
    if (Number.isNaN(date.getTime())) throw new Error("invalid game.date");
    /** @type {Record<string, any>} */
    const doc = { ...game, userId, date };
    delete doc._id;
    const res = await this.db.games.updateOne(
      { userId, gameId: game.gameId },
      {
        $setOnInsert: { createdAt: new Date() },
        $set: doc,
      },
      { upsert: true },
    );
    return res.upsertedCount === 1;
  }

  /**
   * Page games by date, newest first. Optional opponent filter.
   *
   * @param {string} userId
   * @param {{limit?: number, before?: Date, oppPulseId?: string}} [opts]
   */
  async list(userId, opts = {}) {
    const limit = clampLimit(opts.limit, LIMITS.GAMES_PAGE_SIZE);
    /** @type {Record<string, any>} */
    const filter = { userId };
    if (opts.oppPulseId) filter.oppPulseId = opts.oppPulseId;
    if (opts.before instanceof Date && !Number.isNaN(opts.before.getTime())) {
      filter.date = { $lt: opts.before };
    }
    const items = await this.db.games
      .find(filter, { projection: { _id: 0 } })
      .sort({ date: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const nextBefore = hasMore ? page[page.length - 1].date : null;
    return { items: page, nextBefore };
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   */
  async get(userId, gameId) {
    return this.db.games.findOne(
      { userId, gameId },
      { projection: { _id: 0 } },
    );
  }

  /**
   * @param {string} userId
   * @returns {Promise<{total: number, latest: Date|null}>}
   */
  async stats(userId) {
    const total = await this.db.games.countDocuments({ userId });
    const latest = await this.db.games
      .find({ userId }, { projection: { date: 1, _id: 0 } })
      .sort({ date: -1 })
      .limit(1)
      .toArray();
    return { total, latest: latest[0]?.date || null };
  }
}

/** @param {unknown} raw @param {number} fallback @returns {number} */
function clampLimit(raw, fallback) {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, fallback);
}

module.exports = { GamesService };
