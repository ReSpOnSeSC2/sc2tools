"use strict";

/**
 * GameDetailsService — owns the per-game heavy-field blob.
 *
 * Why split the collection
 * ------------------------
 * Pre-v0.4.3, every ``games`` row carried four large arrays inline:
 *
 *   - ``buildLog`` / ``oppBuildLog``        ~10 kB each
 *   - ``macroBreakdown.stats_events`` /
 *     ``macroBreakdown.opp_stats_events``   ~6 kB each (after the
 *                                            v0.4.3 30 s downsample)
 *   - ``apmCurve``                          ~2 kB
 *
 * The Recent Games table, aggregation $facets, BuildsService stats
 * pipelines, and OpponentsService profile loader all read from
 * ``games`` but only need slim metadata (gameId, date, result, race,
 * map, durationSec, macroScore, apm, spq, opponent block). Yet
 * Mongo's working-set behaviour means a list scan of N games has to
 * pull each full document into RAM to pluck out the projection. At
 * 30 k+ games that's an extra ~1 GB of disk I/O per cold list query
 * for fields the route doesn't return.
 *
 * Service pattern
 * ---------------
 * ``GameDetailsService`` is the public API every reader and writer
 * touches. Internally it delegates blob I/O to a backend implementing
 * the contract from ``services/gameDetailsStore.js``:
 *
 *   - ``MongoDetailsStore``  — default, queryable, in-database.
 *   - ``R2DetailsStore``     — Cloudflare R2 / AWS S3 / Backblaze B2.
 *                              ~50× cheaper per GB; right choice
 *                              past ~1M games. Selected via
 *                              ``GAME_DETAILS_STORE=r2`` env var.
 *
 * Spatial extracts deliberately stay inline on ``games`` and are
 * NOT routed through this service — they're small (~5 kB) and the
 * heatmap aggregations in ``services/spatial.js`` require Mongo-side
 * filtering on ``spatial.*`` fields that R2 can't serve.
 */

/**
 * Field names that belong on the detail blob, NOT on the slim
 * ``games`` row. Single source of truth — the ingest path, the read
 * path, and the migration scripts all import this.
 */
const HEAVY_FIELDS = Object.freeze([
  "buildLog",
  "oppBuildLog",
  "macroBreakdown",
  "apmCurve",
]);

class GameDetailsService {
  /**
   * @param {{
   *   write: (userId: string, gameId: string, date: Date, blob: object) => Promise<void>,
   *   read: (userId: string, gameId: string) => Promise<object | null>,
   *   readMany: (userId: string, gameIds: string[], opts?: object) => Promise<Map<string, object>>,
   *   delete: (userId: string, gameId: string) => Promise<void>,
   *   deleteAllForUser: (userId: string) => Promise<void>,
   * }} store  Backend that satisfies the gameDetailsStore contract.
   */
  constructor(store) {
    if (!store) throw new Error("GameDetailsService: store required");
    this.store = store;
  }

  /**
   * Persist the heavy blob for one game. Called by the games ingest
   * path after the slim row is upserted, plus by the per-game
   * recompute writers (writeMacroBreakdown / writeApmCurve /
   * writeOpponentBuildOrder).
   *
   * Detail-write failures are best-effort: a missing blob degrades
   * the per-game inspector to its empty state but never breaks the
   * list views. Callers may wrap this in their own try/catch when
   * they want to log; this method itself doesn't suppress, so a
   * test harness can assert the failure path explicitly.
   *
   * @param {string} userId
   * @param {string} gameId
   * @param {Date} date  duplicated onto the detail row so GDPR
   *                     date-range deletes can match without a join.
   * @param {Record<string, any>} fields  pre-validated heavy fields;
   *                                     any extras are passed through.
   */
  async upsert(userId, gameId, date, fields) {
    if (!userId) throw new Error("userId required");
    if (!gameId) throw new Error("gameId required");
    /** @type {Record<string, any>} */
    const blob = {};
    let any = false;
    for (const k of HEAVY_FIELDS) {
      if (fields[k] !== undefined) {
        blob[k] = fields[k];
        any = true;
      }
    }
    if (!any) {
      // Nothing heavy to persist (legacy v0.3.x agent, or AI game).
      // Skip the write so we don't store an empty blob.
      return;
    }
    await this.store.write(userId, gameId, date, blob);
  }

  /**
   * Fetch the blob for one game. Returns ``null`` when no detail
   * row exists.
   *
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<Record<string, any> | null>}
   */
  async findOne(userId, gameId) {
    return this.store.read(userId, gameId);
  }

  /**
   * Bulk fetch — used by the opponent profile loader, ML training
   * NDJSON writer, and customBuilds preview cursor. Returns a Map
   * keyed by gameId so callers can merge with their slim games array
   * in O(N).
   *
   * @param {string} userId
   * @param {string[]} gameIds
   * @returns {Promise<Map<string, Record<string, any>>>}
   */
  async findMany(userId, gameIds) {
    return this.store.readMany(userId, gameIds);
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   */
  async delete(userId, gameId) {
    await this.store.delete(userId, gameId);
  }

  /**
   * Bulk delete every detail row for a user. Used by GDPR
   * delete-account.
   *
   * @param {string} userId
   */
  async deleteAllForUser(userId) {
    await this.store.deleteAllForUser(userId);
  }
}

module.exports = { GameDetailsService, HEAVY_FIELDS };
