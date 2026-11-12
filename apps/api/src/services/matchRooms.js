"use strict";

const { timingSafeEqual } = require("crypto");
const { randomToken, sha256 } = require("../util/hash");
const { isDuplicateKey } = require("../util/jobLock");
const { MatchRoomError, roomConfig, initialRoom, advanceExpiredTurns,
  reduceMatchRoom, roomSnapshot } = require("./matchRoomModel");

const LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ROOMS = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const KEY_PATTERN = /^(?:[A-Za-z0-9_-]{32}|[0-9a-f]{64})$/u;
const WRITE_ROLES = /** @type {const} */ (["host", "a", "b"]);

/** @typedef {import("./matchRoomModel").RoomState} RoomState */
/** @typedef {typeof WRITE_ROLES[number]} WriteRole */
/** @typedef {{_id: string, _schemaVersion: number, slot: number, rev: number, expiresAt: Date,
 * credentials: Record<WriteRole, string>, state: RoomState}} MatchRoomDoc */

/** @param {string} hostKey @param {"a"|"b"} seat */
function inviteKey(hostKey, seat) {
  return sha256("match-room/seat-" + seat + ":" + hostKey);
}

/** @param {string} hostKey @returns {MatchRoomDoc["credentials"]} */
function roomCredentials(hostKey) {
  return { host: sha256(hostKey), a: sha256(inviteKey(hostKey, "a")), b: sha256(inviteKey(hostKey, "b")) };
}

/** @param {MatchRoomDoc} doc @param {unknown} key @returns {WriteRole} */
function writeRole(doc, key) {
  if (typeof key === "string" && KEY_PATTERN.test(key)) {
    const digest = Buffer.from(sha256(key), "hex");
    for (const role of WRITE_ROLES) {
      if (timingSafeEqual(digest, Buffer.from(doc.credentials[role], "hex"))) return role;
    }
  }
  throw new MatchRoomError(403, "invalid_room_key");
}

class MatchRoomsService {
  /** @param {import("mongodb").Collection<MatchRoomDoc>} rooms
   * @param {{now?: () => number, capacity?: number}} [options] */
  constructor(rooms, { now = Date.now, capacity = MAX_ROOMS } = {}) {
    this.rooms = rooms;
    this.now = now;
    this.capacity = capacity;
  }

  /** @param {unknown} input */
  async create(input) {
    const config = roomConfig(input);
    const id = randomToken(24);
    const hostKey = randomToken(24);
    const now = this.now();
    const occupied = await this.rooms.find({ expiresAt: { $gt: new Date(now) } },
      { projection: { slot: 1, _id: 0 } }).toArray();
    const active = new Set(occupied.map(row => row.slot));
    const base = { _id: sha256(id), _schemaVersion: 1, rev: 0, expiresAt: new Date(now + LIFE_MS),
      credentials: roomCredentials(hostKey), state: initialRoom(config, randomToken(24)) };
    // The unique slot index enforces the hard cap even across overlapping API
    // processes. Reclaim an expired slot without waiting for the TTL sweep.
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (active.has(slot)) continue;
      await this.rooms.deleteOne({ slot, expiresAt: { $lte: new Date(now) } });
      try {
        await this.rooms.insertOne({ ...base, slot });
        return { id, hostKey };
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    throw new MatchRoomError(503, "match_rooms_full");
  }

  /** @param {string} id @param {number} now */
  async load(id, now) {
    if (!ID_PATTERN.test(id)) throw new MatchRoomError(404, "match_room_missing");
    const doc = await this.rooms.findOne({ _id: sha256(id), expiresAt: { $gt: new Date(now) } });
    if (!doc) throw new MatchRoomError(404, "match_room_missing");
    return doc;
  }

  /** @param {MatchRoomDoc} doc @param {RoomState} state @param {number} now */
  async save(doc, state, now) {
    const result = await this.rooms.updateOne(
      { _id: doc._id, rev: doc.rev, expiresAt: { $gt: new Date(now) } },
      { $set: { state }, $inc: { rev: 1 } },
    );
    return result.matchedCount === 1 ? { ...doc, state, rev: doc.rev + 1 } : null;
  }

  /** @param {string} id @param {number} now */
  async current(id, now) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const doc = await this.load(id, now);
      const state = advanceExpiredTurns(doc.state, now);
      if (state === doc.state) return doc;
      const advanced = await this.save(doc, state, now);
      if (advanced) return advanced;
    }
    throw new MatchRoomError(409, "match_room_changed");
  }

  /** @param {string} id @param {number|null} rev */
  async read(id, rev) {
    const now = this.now();
    if (rev !== null && ID_PATTERN.test(id)) {
      // Most polls match an unchanged revision. Avoid copying the complete
      // room over the database connection unless its state or timer changed.
      const unchanged = await this.rooms.findOne({ _id: sha256(id), rev, expiresAt: { $gt: new Date(now) },
        $or: [{ "state.deadline": null }, { "state.deadline": { $gt: now } }] }, { projection: { _id: 1 } });
      if (unchanged) return null;
    }
    const doc = await this.current(id, now);
    return doc.rev === rev ? null : roomSnapshot(doc.state, doc.rev, doc.expiresAt, now);
  }

  /** @param {string} id @param {unknown} key @param {unknown} rev @param {unknown} action */
  async act(id, key, rev, action) {
    if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) {
      throw new MatchRoomError(400, "invalid_room_revision");
    }
    const now = this.now();
    const original = await this.load(id, now);
    const role = writeRole(original, key);
    const doc = original.state.deadline !== null && original.state.deadline <= now
      ? await this.current(id, now)
      : original;
    if (doc.rev !== rev) throw new MatchRoomError(409, "match_room_changed");
    const state = reduceMatchRoom(doc.state, role, action, now);
    const updated = await this.save(doc, state, now);
    if (!updated) throw new MatchRoomError(409, "match_room_changed");
    return roomSnapshot(updated.state, updated.rev, updated.expiresAt, now);
  }

  /** @param {string} id @param {unknown} key */
  async remove(id, key) {
    const now = this.now();
    const doc = await this.load(id, now);
    if (writeRole(doc, key) !== "host") throw new MatchRoomError(403, "host_required");
    await this.rooms.deleteOne({ _id: doc._id });
  }
}

module.exports = { MatchRoomsService, LIFE_MS };
