"use strict";

// Changed-since reads of the analysis corpus (roadmap analysis-corpus-local-cache, slice AC2). A client keeps the
// corpus from a snapshot and later asks only for rows whose `updatedAt` stamp (util/corpusUpdatedAt.js) moved after its
// watermark. A corpus row comes back serialized like a snapshot item; a row that left the corpus (tombstoned, pending
// deletion, hidden or quarantined as a resumed replay) comes back as `{gameId, removed: true}`. Hard deletes leave no
// row, so history wipes and restores bump the owner's `corpusVersion`, and a client on another version must take a new
// snapshot. `dataRev` is not a change feed. Stamps are taken when a write is issued, so the returned watermark trails
// the first page by OVERLAP_MS, which covers commit lag and clock skew; rows near the watermark may come back twice.
const { ObjectId } = require("mongodb");
const { ANALYSIS_GAME_PROJECTION, serializeAnalysisGame } = require("./games");
const { isStatsGame } = require("../util/gameVisibility");
const { LIMITS } = require("../config/constants");

const OVERLAP_MS = 5 * 60 * 1000;
// A process from before change stamps can keep writing unstamped rows during a rolling deploy (at most 300 s after the
// new process listens, ADR 0072 G1). Watermarks before this durable floor cannot be trusted, so they need a snapshot.
const STAMP_FLOOR_ID = "analysisCorpusStampFloor";
const STAMP_FLOOR_GUARD_MS = 7 * 60 * 1000;
const MEMBERSHIP = Object.freeze({ updatedAt: 1, _deleted: 1, _deletionPending: 1, excluded: 1, isResumedFromReplay: 1 });
const PROJECTION = Object.freeze({ ...ANALYSIS_GAME_PROJECTION, ...MEMBERSHIP });

class AnalysisCorpusChanges {
  /** @param {import('../db/connect').DbContext} db @param {{now?: () => number}} [opts] */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || Date.now;
  }

  /** @param {string} userId @returns {Promise<number>} */
  async corpusVersion(userId) {
    const row = await this.db.users.findOne({ userId }, { projection: { _id: 0, corpusVersion: 1 } });
    const version = row?.corpusVersion;
    return Number.isSafeInteger(version) ? version : 0;
  }

  /** The first caller creates the floor; later ones read it. @returns {Promise<Date>} */
  async stampFloor() {
    const row = await this.db.siteConfig.findOneAndUpdate({ _id: /** @type {any} */ (STAMP_FLOOR_ID) },
      { $setOnInsert: { since: new Date(this.now() + STAMP_FLOOR_GUARD_MS) } },
      { upsert: true, returnDocument: "after", projection: { _id: 0, since: 1 } });
    const since = row?.since;
    return since instanceof Date ? since : new Date(this.now() + STAMP_FLOOR_GUARD_MS);
  }

  /** What a snapshot's first page tells the client to keep: its corpus version and the watermark to ask from next.
   * Taken before the page is read, so the watermark never passes a row the snapshot missed.
   * @param {string} userId @returns {Promise<{corpusVersion: number, watermark: string}>} */
  async snapshotMarks(userId) {
    return { corpusVersion: await this.corpusVersion(userId), watermark: new Date(this.now() - OVERLAP_MS).toISOString() };
  }

  /** One page of rows stamped after `since`, oldest stamp first.
   * @param {string} userId
   * @param {{since?: unknown, corpusVersion?: unknown, cursor?: unknown, limit?: number, signal?: AbortSignal}} opts */
  async listChanges(userId, opts) {
    const since = parseSince(opts.since), clientVersion = parseVersion(opts.corpusVersion), cursor = decodeChangesCursor(opts.cursor);
    const [version, floor] = await Promise.all([this.corpusVersion(userId), this.stampFloor()]);
    if (clientVersion !== version) return { snapshotRequired: "corpus_version", corpusVersion: version };
    if (since.getTime() < floor.getTime()) return { snapshotRequired: "before_stamps", corpusVersion: version };
    const limit = clampLimit(opts.limit), start = cursor ? cursor.start : this.now();
    /** @type {Record<string, any>} */
    const filter = { userId, updatedAt: { $gt: since } };
    if (cursor) filter.$or = [{ updatedAt: { $gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, _id: { $gt: cursor.id } }];
    const rows = await this.db.games.find(filter, { projection: PROJECTION, ...(opts.signal ? { signal: opts.signal } : {}) })
      .sort({ updatedAt: 1, _id: 1 }).limit(limit + 1).toArray();
    const page = rows.slice(0, limit), last = page.at(-1), more = rows.length > limit;
    return {
      items: page.map(changeItem),
      nextCursor: more && last ? encodeChangesCursor(start, last.updatedAt, last._id) : null,
      watermark: more ? null : new Date(Math.max(since.getTime(), start - OVERLAP_MS)).toISOString(),
      corpusVersion: version,
    };
  }
}

/** @param {Record<string, any>} row */
function changeItem(row) {
  if (!isStatsGame(row) || row.isResumedFromReplay === true) return { gameId: row.gameId, removed: true };
  const corpus = { ...row };
  for (const field of Object.keys(MEMBERSHIP)) delete corpus[field];
  return serializeAnalysisGame(corpus);
}

/** @param {unknown} raw @returns {Date} */
function parseSince(raw) {
  const date = typeof raw === "string" && raw.length <= 40 ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw badRequest("since must be a watermark from the snapshot or a previous delta");
  return date;
}

/** @param {unknown} raw @returns {number} */
function parseVersion(raw) {
  const version = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 0) throw badRequest("corpus_version must be the snapshot's corpusVersion");
  return version;
}

/** @param {unknown} raw @returns {number} */
function clampLimit(raw) {
  const fallback = LIMITS.GAMES_ANALYSIS_PAGE_SIZE || 2000, ceiling = LIMITS.GAMES_ANALYSIS_PAGE_MAX || fallback;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), ceiling) : fallback;
}

/** @param {number} start @param {Date} updatedAt @param {ObjectId} id */
function encodeChangesCursor(start, updatedAt, id) {
  return Buffer.from(JSON.stringify({ v: 1, s: start, u: updatedAt.toISOString(), i: id.toHexString() }), "utf8").toString("base64url");
}

/** @param {unknown} raw @returns {{start: number, updatedAt: Date, id: ObjectId}|null} */
function decodeChangesCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    if (typeof raw !== "string" || raw.length > 256) throw new Error("cursor");
    const cursor = changesCursorFields(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (!cursor) throw new Error("cursor");
    return cursor;
  } catch {
    throw badRequest("invalid changes cursor");
  }
}

/** @param {any} parsed @returns {{start: number, updatedAt: Date, id: ObjectId}|null} */
function changesCursorFields(parsed) {
  const updatedAt = new Date(parsed?.u), id = typeof parsed?.i === "string" ? parsed.i.toLowerCase() : "";
  const valid = parsed.v === 1 && Number.isSafeInteger(parsed.s) && !Number.isNaN(updatedAt.getTime())
    && ObjectId.isValid(id) && new ObjectId(id).toHexString() === id;
  return valid ? { start: parsed.s, updatedAt, id: new ObjectId(id) } : null;
}

/** @param {string} message */
function badRequest(message) { return Object.assign(new Error(message), { status: 400, code: "bad_request" }); }

module.exports = { AnalysisCorpusChanges, OVERLAP_MS, STAMP_FLOOR_ID, STAMP_FLOOR_GUARD_MS };
