"use strict";

const { sha256 } = require("../util/hash");
const { isDuplicateKey } = require("../util/jobLock");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { currentDay, createDailySchedule, DAY_MS, PACK_DIGEST } = require("./dailySchedule");

const FLOOR = 20;
const FIGHTS = 5;
const CHOICES = 5;
const BUCKETS = 64;
const BUCKET_CAP = 512;
const KEYS = new Set(["day", "pack", "answers", "attempt"]);
const ATTEMPT = /^[0-9a-f]{32}$/u;

/** @typedef {{day:number, pack:string, answers:number[], attempt:string}} Ballot */
/** @typedef {{_id:string, _schemaVersion:number, day:number, pack:string, expiresAt:Date,
 * total:number, receipts:string[], counts:Record<string,number>}} Tally */
/** @typedef {{_id:string, _schemaVersion:number, day:number, pinnedPack:string, expiresAt:Date}} DayPin */
/** @typedef {DayPin | Tally} TallyRow */

/** @param {unknown} value @returns {value is Ballot} */
function isBallot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  if (fields.length !== KEYS.size || fields.some(key => !KEYS.has(key))) return false;
  const { day, pack, answers, attempt } = /** @type {Ballot} */ (value);
  return Number.isSafeInteger(day) && day > 0 && isToken(pack, PACK_DIGEST)
    && validAnswers(answers) && isToken(attempt, ATTEMPT);
}

/** @param {unknown} value @param {RegExp} pattern */
const isToken = (value, pattern) => typeof value === "string" && pattern.test(value);

/** @param {unknown} value */
function validAnswers(value) {
  return Array.isArray(value) && value.length === FIGHTS
    && value.every(call => Number.isInteger(call) && call >= 0 && call < CHOICES);
}

/** @param {number} status @param {string} code */
function dailyError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

/** @param {Pick<Tally, "total" | "counts">[]} rows */
function crowdSplit(rows) {
  const total = rows.reduce((count, row) => count + row.total, 0);
  if (total < FLOOR) return { state: "waiting" };
  const fights = Array.from({ length: FIGHTS }, (_, fight) =>
    Array.from({ length: CHOICES }, (_, call) => {
      const key = String(fight * CHOICES + call);
      return rows.reduce((count, row) => count + (row.counts[key] ?? 0), 0);
    }));
  return { state: "ready", total, fights };
}

class DailyCrowdService {
  /** @param {import("mongodb").Collection<TallyRow>} tally
   * @param {{now?:() => number, schedule?:(day:number) => Promise<string|null>}} [options] */
  constructor(tally, { now = Date.now, schedule = createDailySchedule({ now }) } = {}) {
    this.tally = tally;
    this.now = now;
    this.schedule = schedule;
  }

  /** @param {unknown} input */
  async submit(input) {
    if (!isBallot(input)) throw dailyError(400, "invalid_daily_calls");
    const { day, pack, attempt } = input;
    if (day !== currentDay(this.now()) || await this.schedule(day) !== pack
      || day !== currentDay(this.now())) throw dailyError(404, "daily_calls_unavailable");
    if (!await this.matchesPinnedPack(day, pack) || day !== currentDay(this.now())) {
      throw dailyError(404, "daily_calls_unavailable");
    }
    const receipt = sha256(`daily:${day}:${attempt}`);
    const bucket = Number.parseInt(receipt.slice(0, 2), 16) % BUCKETS;
    await this.record(`${day}:${pack}:${bucket}`, receipt, input);
    const rows = await this.tally.find({ day, pack }, { projection: { _id: 0, total: 1, counts: 1 } }).limit(BUCKETS).toArray();
    return crowdSplit(/** @type {Pick<Tally, "total" | "counts">[]} */ (rows));
  }

  /** @param {number} day @param {string} pack */
  async matchesPinnedPack(day, pack) {
    const filter = { _id: `pin:${day}` };
    const pin = stampVersion({ day, pinnedPack: pack, expiresAt: new Date((day + 2) * DAY_MS) }, COLLECTIONS.DAILY_TALLY);
    const projection = { _id: 0, pinnedPack: 1 };
    // The immutable pin shares the TTL index. It has no pack field, so tally reads skip it.
    let stored;
    try {
      stored = await this.tally.findOneAndUpdate(filter, { $setOnInsert: pin }, {
        upsert: true, returnDocument: "after", projection,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      stored = await this.tally.findOne(filter, { projection });
    }
    return stored && "pinnedPack" in stored && stored.pinnedPack === pack;
  }

  /** @param {string} id @param {string} receipt @param {Ballot} ballot */
  async record(id, receipt, { day, pack, answers }) {
    const initial = stampVersion({
      _id: id, day, pack, expiresAt: new Date((day + 2) * DAY_MS),
    }, COLLECTIONS.DAILY_TALLY);
    const filter = { _id: id, receipts: { $ne: receipt }, $or: [{ total: { $lt: BUCKET_CAP } }, { total: { $exists: false } }] };
    const increments = Object.fromEntries(answers.map((call, fight) => [`counts.${fight * CHOICES + call}`, 1]));
    const update = { $addToSet: { receipts: receipt }, $inc: { total: 1, ...increments } };
    try {
      await this.tally.updateOne(filter, { ...update, $setOnInsert: initial }, { upsert: true });
      return;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    // A racing first ballot may have created the bucket. Try the same
    // condition against the existing bucket before distinguishing full from retry.
    const updated = await this.tally.updateOne(filter, update);
    if (!updated.matchedCount && !await this.tally.findOne({ _id: id, receipts: receipt }, { projection: { _id: 1 } })) {
      throw dailyError(503, "daily_calls_full");
    }
  }
}

module.exports = { DailyCrowdService, BUCKET_CAP };
