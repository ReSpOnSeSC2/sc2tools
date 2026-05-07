"use strict";

const { LIMITS, COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { HEAVY_FIELDS } = require("./gameDetails");

/**
 * Games service. One document per (userId, gameId). Idempotent on
 * insert: if the agent re-uploads after a retry, we update existing
 * record rather than duplicate.
 */
class GamesService {
  /**
   * @param {{games: import('mongodb').Collection}} db
   * @param {{ gameDetails?: import('./gameDetails').GameDetailsService }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    // Optional dep so unit tests that only need the slim-row code
    // path can still construct GamesService without a details stub.
    // The ingest path checks for presence before forwarding.
    this.gameDetails = opts.gameDetails || null;
  }

  /**
   * Insert or update a game record. Returns true if it was new.
   *
   * Heavy fields (build logs, macroBreakdown, apmCurve, spatial) are
   * peeled off the input and persisted into ``game_details`` via the
   * injected GameDetailsService. The slim row that lands in
   * ``games`` is roughly 3 kB instead of ~48 kB, which is what makes
   * list/aggregation queries scan-cheap at scale (the v0.4.3 split
   * — see ``services/gameDetails.js`` for the rationale).
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
    delete doc._schemaVersion;
    // Capture heavy fields BEFORE the slim doc is finalised so we
    // can hand them to GameDetailsService. The slim row that lands
    // in ``games`` is then stripped of every heavy field plus the
    // legacy early-log fields. Total slim size: ~3 kB / doc instead
    // of ~30 kB.
    //
    // Why we $unset every heavy field on the slim row even though
    // we already deleted it from ``doc``: pre-cutover documents
    // that already exist in ``games`` carry the heavy fields inline.
    // The $set patch alone would leave them sitting on disk
    // indefinitely. The $unset clears them as part of the same
    // upsert — incremental cutover happens naturally as users
    // re-upload.
    /** @type {Record<string, any>} */
    const heavy = {};
    for (const k of HEAVY_FIELDS) {
      if (doc[k] !== undefined) heavy[k] = doc[k];
      delete doc[k];
    }
    delete doc.earlyBuildLog;
    delete doc.oppEarlyBuildLog;
    stampVersion(doc, COLLECTIONS.GAMES);
    /** @type {Record<string, string>} */
    const unset = { earlyBuildLog: "", oppEarlyBuildLog: "" };
    for (const k of HEAVY_FIELDS) unset[k] = "";
    const res = await this.db.games.updateOne(
      { userId, gameId: game.gameId },
      {
        $setOnInsert: { createdAt: new Date() },
        $set: doc,
        $unset: unset,
      },
      { upsert: true },
    );
    if (this.gameDetails && Object.keys(heavy).length > 0) {
      // Detail-write failures DO propagate now that the slim row no
      // longer carries the heavy fields. A silent failure here
      // would leave the per-game inspector permanently empty. The
      // ingest route catches and logs; failure of one game doesn't
      // block subsequent games in a batch upload.
      await this.gameDetails.upsert(userId, game.gameId, date, heavy);
    }
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
