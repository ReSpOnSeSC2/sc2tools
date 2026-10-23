"use strict";

const { randomUUID } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { digest, failure, text, sideOf, normalizeTarget, ownedReplayTarget } = require("./ghostTargets");

class GhostExamplesService {
  /** @param {{db:any, gameDetails?:any, now?:()=>Date}} deps */
  constructor(deps) {
    this.db = deps.db;
    this.collection = deps.db.ghostExamples || deps.db.db?.collection?.("ghost_examples");
    this.gameDetails = deps.gameDetails || null;
    this.now = deps.now || (() => new Date());
  }

  _store() {
    if (!this.collection) throw failure("ghost_catalog_unavailable", 503);
    return this.collection;
  }

  /** @param {string} owner @param {any} body */
  async preview(owner, body) {
    const sourceGameId = text(body.gameId, 200, true);
    const side = sideOf(body.side);
    const source = await ownedReplayTarget(this.db, this.gameDetails, owner, sourceGameId, side);
    const name = body.name === undefined ? source.target.name : text(body.name, 80, true);
    const description = text(body.description, 500);
    const target = { ...source.target, name, sourceGameId: "example:preview" };
    const preview = {
      name, description, myRace: source.myRace, opponentRace: source.opponentRace,
      matchup: source.matchup, map: typeof source.game.map === "string" ? source.game.map.slice(0, 200) : null,
      durationSec: Number.isFinite(source.game.durationSec) && source.game.durationSec >= 0 ? source.game.durationSec : null,
      stepCount: target.steps.length, target,
    };
    return { ...preview, previewToken: digest(JSON.stringify({ owner, sourceGameId, side, preview })) };
  }

  /** @param {string} owner @param {any} body */
  async publish(owner, body) {
    const lease = await claimUserDataLease(this.db.users, owner);
    try {
      return await this._publish(owner, body);
    } finally {
      await lease.release();
    }
  }

  /** @param {string} owner @param {any} body */
  async _publish(owner, body) {
    const collection = this._store();
    const sourceGameId = text(body.gameId, 200, true);
    const preview = await this.preview(owner, body);
    const { previewToken, ...visible } = preview;
    if (body.previewToken !== previewToken) throw failure("ghost_preview_changed", 409);
    const existing = await collection.findOne({ ownerUserId: owner, sourceGameId, side: sideOf(body.side) }, { projection: { _id: 1 } });
    const id = existing?._id || randomUUID();
    const document = stampVersion({ ...visible, _id: id, target: { ...visible.target, sourceGameId: "example:" + id }, ownerUserId: owner, sourceGameId, side: sideOf(body.side), publishedAt: this.now() }, COLLECTIONS.GHOST_EXAMPLES);
    try {
      await collection.replaceOne({ _id: id }, document, { upsert: true });
    } catch (error) {
      if (/** @type {any} */ (error).code !== 11000) throw error;
      const current = await collection.findOne({ ownerUserId: owner, sourceGameId, side: sideOf(body.side) }, { projection: { _id: 1 } });
      if (!current) throw error;
      document._id = current._id;
      document.target.sourceGameId = "example:" + current._id;
      await collection.replaceOne({ _id: current._id }, document);
    }
    return publicExample(document, true);
  }

  /** @param {{owner?:string,matchup?:string}} [options] */
  async list(options = {}) {
    const filter = { ...(options.owner ? { ownerUserId: options.owner } : {}), ...(options.matchup ? { matchup: options.matchup } : {}) };
    const rows = await this._store().find(filter, { projection: { ownerUserId: 0, sourceGameId: 0, side: 0, "target.steps": 0 } }).sort({ publishedAt: -1, _id: 1 }).limit(100).toArray();
    return { items: rows.map((/** @type {any} */ row) => publicExample(row, false)), nextCursor: null };
  }

  /** @param {string} id */
  async get(id) {
    text(id, 80, true);
    const row = await this._store().findOne({ _id: id });
    if (!row) throw failure("ghost_example_not_found", 404);
    return publicExample(row, true);
  }

  /** @param {string} owner @param {string} id */
  async remove(owner, id) {
    text(id, 80, true);
    const result = await this._store().deleteOne({ _id: id, ownerUserId: owner });
    if (!result.deletedCount) throw failure("ghost_example_not_found", 404);
  }
}

/** @param {any} row @param {boolean} includeTarget */
function publicExample(row, includeTarget) {
  const publishedAt = row.publishedAt instanceof Date ? row.publishedAt.toISOString() : row.publishedAt;
  return {
    id: row._id, name: row.name, description: row.description, myRace: row.myRace,
    opponentRace: row.opponentRace, matchup: row.matchup, map: row.map,
    durationSec: row.durationSec, stepCount: row.stepCount, publishedAt,
    ...(includeTarget ? { target: normalizeTarget(row.target) } : {}),
  };
}

module.exports = { GhostExamplesService };
