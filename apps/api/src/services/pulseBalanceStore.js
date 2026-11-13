"use strict";

const { BSON, MongoError, MongoNetworkError } = require("mongodb");
const { COLLECTIONS } = require("../config/constants");
const { assertNotTooNew, stampVersion } = require("../db/schemaVersioning");
const { isDuplicateKey } = require("../util/jobLock");
const { TIER_REQUESTS } = require("./pulseBalanceAdapter");

const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;

/** @typedef {import("./pulseBalanceAdapter").TierCube} TierCube */
/** @typedef {ReturnType<typeof import("./pulseBalanceSummary").summarizeBalance>} Bundle */
/** @typedef {{bundle:Bundle,tiers:TierCube[]}} Snapshot */
/** @typedef {{_id:number,asOf:string,bundle:Bundle,tiers:ReturnType<typeof packTier>[],_schemaVersion?:number}} CurrentSnapshot */
/** @typedef {{_id:string,startedAt:Date,season?:number,tiers?:ReturnType<typeof rollupTier>[],_schemaVersion?:number}} DailySnapshot */

/** @param {TierCube} tier */
function packTier({ league, division, rows, bounds }) {
  const maps = new Map(rows.map(({ mapId, map }) => /** @type {const} */ ([mapId, map])));
  return {
    league, division, bounds, maps: [...maps],
    rows: rows.map(({ matchup, mapId, region, crossTier, duration, wins, games }) =>
      /** @type {const} */ ([matchup, mapId, region, crossTier, duration, wins, games])),
  };
}

/** @param {TierCube} tier */
function rollupTier({ league, division, rows }) {
  /** @type {Map<string,[TierCube["rows"][number]["matchup"],boolean,number,number,number]>} */
  const counts = new Map();
  for (const { matchup, crossTier, duration, wins, games } of rows) {
    const key = JSON.stringify([matchup, crossTier, duration]);
    const row = counts.get(key) ?? [matchup, crossTier, duration, 0, 0];
    row[3] += wins;
    row[4] += games;
    counts.set(key, row);
  }
  return { league, division, rows: [...counts.values()] };
}

class PulseBalanceStore {
  /** @param {{current:import("mongodb").Collection<CurrentSnapshot>,daily:import("mongodb").Collection<DailySnapshot>}} deps */
  constructor({ current, daily }) {
    this.current = current;
    this.daily = daily;
  }

  async latest() {
    const doc = await this.current.findOne({}, { sort: { _id: -1 }, projection: { bundle: 1, _schemaVersion: 1 } });
    if (!doc) return null;
    assertNotTooNew(doc, COLLECTIONS.PULSE_BALANCE_CURRENT);
    return doc.bundle;
  }

  /** @param {string} asOf @param {number} now */
  async claim(asOf, now) {
    try {
      await this.daily.insertOne(stampVersion({ _id: asOf, startedAt: new Date(now) }, COLLECTIONS.PULSE_BALANCE_DAILY));
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  /** @param {Snapshot} snapshot */
  async publish(snapshot) {
    try {
      return await this.writeSnapshot(snapshot);
    } catch (error) {
      if (!(error instanceof MongoNetworkError)
        && !(error instanceof MongoError && error.hasErrorLabel("RetryableWriteError"))) throw error;
      return this.writeSnapshot(snapshot);
    }
  }

  /** @private @param {Snapshot} snapshot */
  async writeSnapshot({ bundle, tiers }) {
    const { asOf, season } = bundle;
    if (tiers.length !== TIER_REQUESTS.length || bundle.tiers.length !== TIER_REQUESTS.length
      || TIER_REQUESTS.some(request => !tiers.some(tier => tier.league === request.league && tier.division === request.division))) {
      throw Object.assign(new Error("Balance tier coverage is incomplete"), { code: "pulse_balance_tier_coverage" });
    }
    const current = stampVersion({ _id: season, asOf, bundle, tiers: tiers.map(packTier) }, COLLECTIONS.PULSE_BALANCE_CURRENT);
    if (BSON.calculateObjectSize(current) > MAX_SNAPSHOT_BYTES) {
      throw Object.assign(new Error("Balance snapshot is too large"), { code: "pulse_balance_snapshot_too_large" });
    }

    // Write validated history first. Readers only see complete bundles through
    // the atomic current document, and a late writer cannot replace a newer day.
    const rollup = await this.daily.updateOne({ _id: asOf, $or: [{ season: { $exists: false } }, { season }] },
      { $set: { season, tiers: tiers.map(rollupTier) } });
    if (!rollup.matchedCount) {
      throw Object.assign(new Error("Balance day is no longer claimed"), { code: "pulse_balance_day_unclaimed" });
    }
    try {
      await this.current.replaceOne({ _id: season, asOf: { $lte: asOf } }, current, { upsert: true });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }
}

module.exports = { PulseBalanceStore };
