"use strict";

/** Hidden rows remain owner-readable; permanent-intent rows do not. */
const LIVE_GAME_MATCH = Object.freeze({
  _deleted: { $ne: true },
  _deletionPending: { $ne: true },
});
/** Eligibility belongs to this owner's contribution, before samples or deduplication. */
const STATS_GAME_MATCH = Object.freeze({ ...LIVE_GAME_MATCH, excluded: { $ne: true } });

/** @param {any} row */
const isLiveGame = (row) => !!row && row._deleted !== true && row._deletionPending !== true;
/** @param {any} row */
const isStatsGame = (row) => isLiveGame(row) && row.excluded !== true;

/** Bounded identity tokens fence late cache writes even after an owner is evicted. */
class OwnerRevisions {
  constructor() {
    /** @type {Map<string, {id:number}>} */ this.owners = new Map();
    this.sequence = 0;
  }
  /** @param {string} owner */
  get(owner) {
    let token = this.owners.get(owner);
    if (!token) token = { id: ++this.sequence };
    this.owners.delete(owner); this.owners.set(owner, token);
    if (this.owners.size > 4096) this.owners.delete(this.owners.keys().next().value || "");
    return token;
  }
  /** @param {string} owner */
  invalidate(owner) { this.owners.delete(owner); return this.get(owner); }
  /** @param {string} owner @param {{id:number}} token */
  current(owner, token) { return this.owners.get(owner) === token; }
}

module.exports = { LIVE_GAME_MATCH, STATS_GAME_MATCH, isLiveGame, isStatsGame, OwnerRevisions };
