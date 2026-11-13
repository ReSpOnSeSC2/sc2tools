"use strict";

const { createHash, timingSafeEqual } = require("crypto");
const { randomToken, sha256 } = require("../util/hash");
const { isDuplicateKey } = require("../util/jobLock");
const { MatchRoomError, roomConfig, initialRoom, advanceExpiredTurns,
  reduceMatchRoom, roomSnapshot } = require("./matchRoomModel");

const LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const CREATE_RETRY_MS = 10 * 60 * 1000;
const CREATE_ATTEMPT_PATTERN = /^[0-9a-f]{48}$/u;
const MAX_ROOMS = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const KEY_PATTERN = /^(?:[A-Za-z0-9_-]{32}|[0-9a-f]{64})$/u;
const WRITE_ROLES = /** @type {const} */ (["host", "a", "b"]);

/** @typedef {import("./matchRoomModel").RoomState} RoomState */
/** @typedef {RoomState["config"]} RoomConfig */
/** @typedef {typeof WRITE_ROLES[number]} WriteRole */
/** @typedef {{_id: string, _schemaVersion: number, creationDigest: string, expiresAt: Date}} ClosedRoomDoc */
/** @typedef {ClosedRoomDoc & {slot: number, rev: number, creationSalt: string,
 * credentials: Record<WriteRole, string>, state: RoomState}} ActiveRoomDoc */
/** @typedef {ActiveRoomDoc | ClosedRoomDoc} MatchRoomDoc */

/** @param {unknown} input */
function creationAttempt(input) {
  const attempt = input && typeof input === "object" && "attempt" in input ? input.attempt : null;
  if (typeof attempt !== "string" || !CREATE_ATTEMPT_PATTERN.test(attempt)) {
    throw new MatchRoomError(400, "invalid_room_attempt");
  }
  return attempt;
}

/** @param {string} attempt @param {string} salt */
function creationInvite(attempt, salt) {
  const input = salt + ":" + attempt;
  return {
    id: createHash("sha256").update("match-room/create-watch:" + input).digest("base64url").slice(0, 32),
    hostKey: createHash("sha256").update("match-room/create-host:" + input).digest("base64url").slice(0, 32),
  };
}

/** @param {MatchRoomDoc | null} doc @param {RoomConfig} config @param {number} now */
function retrySalt(doc, config, now) {
  if (!doc) return null;
  if (!("slot" in doc) || doc.expiresAt.getTime() <= now) {
    throw new MatchRoomError(409, "match_room_attempt_closed");
  }
  if (JSON.stringify(doc.state.config) !== JSON.stringify(config)) {
    throw new MatchRoomError(409, "match_room_attempt_mismatch");
  }
  return doc.creationSalt;
}

/** @param {string} hostKey @param {"a"|"b"} seat */
function inviteKey(hostKey, seat) {
  return sha256("match-room/seat-" + seat + ":" + hostKey);
}

/** @param {string} hostKey @returns {ActiveRoomDoc["credentials"]} */
function roomCredentials(hostKey) {
  return { host: sha256(hostKey), a: sha256(inviteKey(hostKey, "a")), b: sha256(inviteKey(hostKey, "b")) };
}

/** @param {ActiveRoomDoc} doc @param {unknown} key @returns {WriteRole} */
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
    const attempt = creationAttempt(input);
    const creationDigest = sha256("match-room/creation-attempt:" + attempt);
    const now = this.now();
    const existing = retrySalt(await this.rooms.findOne({ creationDigest }), config, now);
    if (existing) return creationInvite(attempt, existing);
    const creationSalt = randomToken(24);
    const { id, hostKey } = creationInvite(attempt, creationSalt);
    const base = { _id: sha256(id), _schemaVersion: 1, rev: 0, expiresAt: new Date(now + LIFE_MS),
      creationDigest, creationSalt, credentials: roomCredentials(hostKey), state: initialRoom(config, randomToken(24)) };
    return creationInvite(attempt, await this.#claimSlot(base, now));
  }

  /** @param {Omit<ActiveRoomDoc, "slot">} room @param {number} now */
  async #claimSlot(room, now) {
    const { creationDigest, state: { config } } = room;
    const occupied = await this.rooms.find({ expiresAt: { $gt: new Date(now) } },
      { projection: { slot: 1, _id: 0 } }).toArray();
    const active = new Set(occupied.flatMap(row => "slot" in row ? [row.slot] : []));
    // The unique slot index enforces the hard cap even across overlapping API
    // processes. Reclaim an expired slot without waiting for the TTL sweep.
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (active.has(slot)) continue;
      await this.rooms.deleteOne({ slot, expiresAt: { $lte: new Date(now) } });
      try {
        await this.rooms.insertOne({ ...room, slot });
        return room.creationSalt;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        const existing = retrySalt(await this.rooms.findOne({ creationDigest }), config, this.now());
        if (existing) return existing;
      }
    }
    const existing = retrySalt(await this.rooms.findOne({ creationDigest }), config, this.now());
    if (existing) return existing;
    throw new MatchRoomError(503, "match_rooms_full");
  }

  /** @param {string} id @param {number} now */
  async load(id, now) {
    if (!ID_PATTERN.test(id)) throw new MatchRoomError(404, "match_room_missing");
    const doc = await this.rooms.findOne({ _id: sha256(id), expiresAt: { $gt: new Date(now) } });
    if (!doc || !("slot" in doc)) throw new MatchRoomError(404, "match_room_missing");
    return doc;
  }

  /** @param {ActiveRoomDoc} doc @param {RoomState} state @param {number} now */
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
    if (state === doc.state) return roomSnapshot(state, doc.rev, doc.expiresAt, now);
    const updated = await this.save(doc, state, now);
    if (!updated) throw new MatchRoomError(409, "match_room_changed");
    return roomSnapshot(updated.state, updated.rev, updated.expiresAt, now);
  }

  /** @param {string} id @param {unknown} key */
  async remove(id, key) {
    const now = this.now();
    const doc = await this.load(id, now);
    if (writeRole(doc, key) !== "host") throw new MatchRoomError(403, "host_required");
    // Drop room data and release the slot atomically. Keep the digest briefly
    // so a delayed creation request cannot restore deleted capabilities.
    await this.rooms.replaceOne({ _id: doc._id, slot: { $exists: true } }, {
      _schemaVersion: doc._schemaVersion, creationDigest: doc.creationDigest,
      expiresAt: new Date(now + CREATE_RETRY_MS),
    });
  }
}

module.exports = { MatchRoomsService, LIFE_MS };
