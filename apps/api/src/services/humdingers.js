"use strict";

const { createHmac } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Humdingers account saves and anonymous play totals (ADR 0102).
 *
 * The /play/humdingers host page copies the game's localStorage saves
 * ("humdingers.save.<slot>", JSON with fmt "humdingers-save") to the
 * player's account and back. Play totals are one row per UTC day with no
 * user IDs; unique players are counted through a peppered per-day hash
 * that expires after 35 days.
 *
 * @typedef {{userId: string, slot: string, data: string, when: number, playtime: number, chapter: number,
 *   world: string|null, updatedAt: Date}} HumdingersSaveDoc
 * @typedef {{_id: string, loads: number, activeSeconds: number, longPlays: number, uniquePlayers: number,
 *   savers: number, maxChapter: number, updatedAt: Date}} HumdingersPlayDayDoc
 * @typedef {{_id: string, day: string, saved: boolean, expiresAt: Date}} HumdingersPlayPlayerDoc
 */

const SAVE_FORMAT = "humdingers-save";
/** Numbered slots ("0".."9") and named ones such as "auto". */
const SLOT_RE = /^[a-z0-9_]{1,24}$/;
/** Leaves room for JSON escaping inside the API's 256 kB body limit. */
const MAX_SAVE_BYTES = 200_000;
/** The game keeps a handful of slots; more than this is a client bug. */
const MAX_SLOTS = 12;
/** One activity report covers at most the host's 5-minute flush window. */
const MAX_ACTIVE_SECONDS = 600;
const MAX_CHAPTER = 99;
const PLAYER_TTL_MS = 35 * 86_400_000;
const STATS_DAYS = [7, 30, 90];
const DEFAULT_STATS_DAYS = 30;

class HumdingersService {
  /** @param {import('../db/connect').DbContext} db @param {{secret: Buffer|string, now?: () => Date}} opts */
  constructor(db, opts) {
    this.db = db;
    this.secret = opts.secret;
    this.now = opts.now || (() => new Date());
  }

  /** @param {string} userId */
  async listSaves(userId) {
    const rows = await this.db.humdingersSaves
      .find({ userId }, { projection: { _id: 0, slot: 1, data: 1, when: 1, updatedAt: 1 } })
      .sort({ slot: 1 })
      .limit(MAX_SLOTS)
      .toArray();
    return rows.map((row) => ({ slot: row.slot, data: row.data, when: row.when, updatedAt: row.updatedAt }));
  }

  /**
   * Stores a save unless the account already holds a newer one for the slot.
   * The conditional upsert makes "newest wins" atomic: an older save matches
   * nothing, its insert hits the unique index, and the caller gets the stored
   * copy back to write locally.
   * @param {string} userId @param {unknown} slot @param {any} body
   */
  async putSave(userId, slot, body) {
    const save = parseSave(slot, body);
    const existing = await this.db.humdingersSaves.findOne({ userId, slot: save.slot }, { projection: { _id: 1 } });
    if (!existing && await this.db.humdingersSaves.countDocuments({ userId }) >= MAX_SLOTS) {
      throw problem(400, "too_many_slots", `Keep at most ${MAX_SLOTS} Humdingers save slots.`);
    }
    const doc = stampVersion({ userId, ...save, updatedAt: this.now() }, COLLECTIONS.HUMDINGERS_SAVES);
    try {
      await this.db.humdingersSaves.updateOne({ userId, slot: save.slot, when: { $lte: save.when } }, { $set: doc }, { upsert: true });
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000) throw error;
      const newer = await this.db.humdingersSaves.findOne({ userId, slot: save.slot }, { projection: { _id: 0, slot: 1, data: 1, when: 1, updatedAt: 1 } });
      throw Object.assign(problem(409, "newer_save", "This slot has a newer save."), { save: newer });
    }
    return { slot: save.slot, when: save.when, updatedAt: doc.updatedAt };
  }

  /** @param {string} userId @param {unknown} slot */
  async deleteSave(userId, slot) {
    if (typeof slot !== "string" || !SLOT_RE.test(slot)) throw problem(400, "bad_slot", "Unknown save slot.");
    const result = await this.db.humdingersSaves.deleteOne({ userId, slot });
    return { deleted: result.deletedCount === 1 };
  }

  /**
   * One host report: a game load, or active play seconds. Totals only.
   * @param {string} userId @param {any} body
   */
  async recordPlay(userId, body) {
    const play = parsePlay(body);
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    const key = createHmac("sha256", this.secret).update(`humdingers-play:${day}:${userId}`).digest("base64url");
    const first = await this.db.humdingersPlayPlayers.updateOne(
      { _id: key },
      { $setOnInsert: stampVersion({ day, saved: false, expiresAt: new Date(now.getTime() + PLAYER_TTL_MS) }, COLLECTIONS.HUMDINGERS_PLAY_PLAYERS) },
      { upsert: true },
    );
    const firstSave = play.saved
      ? await this.db.humdingersPlayPlayers.updateOne({ _id: key, saved: false }, { $set: { saved: true } })
      : null;
    /** @type {Record<string, number>} */
    const inc = {
      loads: play.type === "load" ? 1 : 0,
      activeSeconds: play.seconds,
      longPlays: play.longPlay ? 1 : 0,
      uniquePlayers: first.upsertedCount === 1 ? 1 : 0,
      savers: firstSave?.modifiedCount === 1 ? 1 : 0,
    };
    await this.db.humdingersPlayDays.updateOne(
      { _id: day },
      {
        $inc: inc,
        $max: { maxChapter: play.chapter },
        $set: { updatedAt: now },
        $setOnInsert: stampVersion({}, COLLECTIONS.HUMDINGERS_PLAY_DAYS),
      },
      { upsert: true },
    );
  }

  /**
   * Admin totals for the trailing 7, 30 or 90 UTC days, newest first.
   * @param {unknown} rawDays
   */
  async stats(rawDays) {
    const days = rawDays === undefined ? DEFAULT_STATS_DAYS : Number(rawDays);
    if (!STATS_DAYS.includes(days)) throw problem(400, "bad_range", "Choose 7, 30 or 90 days.");
    const today = Date.parse(`${this.now().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const keys = Array.from({ length: days }, (_, index) => new Date(today - index * 86_400_000).toISOString().slice(0, 10));
    const rows = await this.db.humdingersPlayDays.find({ _id: { $in: keys } }).toArray();
    const byDay = new Map(rows.map((row) => [row._id, row]));
    const daily = keys.map((day) => {
      const row = byDay.get(day);
      return {
        day,
        loads: row?.loads || 0,
        players: row?.uniquePlayers || 0,
        activeSeconds: row?.activeSeconds || 0,
        longPlays: row?.longPlays || 0,
        savers: row?.savers || 0,
        maxChapter: row?.maxChapter || 0,
      };
    });
    const sum = (/** @type {"loads"|"players"|"activeSeconds"|"longPlays"|"savers"} */ field) => daily.reduce((total, row) => total + row[field], 0);
    return {
      days,
      totals: {
        loads: sum("loads"),
        playerDays: sum("players"),
        activeSeconds: sum("activeSeconds"),
        longPlays: sum("longPlays"),
        savers: sum("savers"),
        maxChapter: daily.reduce((max, row) => Math.max(max, row.maxChapter), 0),
      },
      daily,
    };
  }
}

/** @param {unknown} slot @param {any} body */
function parseSave(slot, body) {
  if (typeof slot !== "string" || !SLOT_RE.test(slot)) throw problem(400, "bad_slot", "Unknown save slot.");
  const data = body?.data;
  if (typeof data !== "string" || !data) throw problem(400, "bad_save", "Send the save as a JSON string.");
  if (Buffer.byteLength(data, "utf8") > MAX_SAVE_BYTES) throw problem(413, "save_too_large", "This save is too large to keep.");
  /** @type {any} */
  let envelope;
  try {
    envelope = JSON.parse(data);
  } catch {
    throw problem(400, "bad_save", "The save is not valid JSON.");
  }
  const meta = envelope?.meta;
  if (!isObject(envelope) || envelope.fmt !== SAVE_FORMAT || !isObject(envelope.state) || !isObject(meta)) {
    throw problem(400, "bad_save", "This is not a Humdingers save.");
  }
  const when = Number(meta.when);
  if (!Number.isSafeInteger(when) || when <= 0) throw problem(400, "bad_save", "The save has no time.");
  return {
    slot,
    data,
    when,
    playtime: clampInt(meta.playtime, 0, 315_360_000),
    chapter: clampInt(meta.chapter, 0, MAX_CHAPTER),
    world: typeof meta.world === "string" && meta.world ? meta.world.slice(0, 40) : null,
  };
}

/** @param {any} body */
function parsePlay(body) {
  const type = body?.type;
  if (type !== "load" && type !== "active") throw problem(400, "bad_play", "Report a load or active time.");
  const seconds = type === "active" ? body.seconds : 0;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_ACTIVE_SECONDS || (type === "active" && seconds === 0)) {
    throw problem(400, "bad_play", `Report 1 to ${MAX_ACTIVE_SECONDS} active seconds.`);
  }
  if (body.chapter !== undefined && (!Number.isInteger(body.chapter) || body.chapter < 0 || body.chapter > MAX_CHAPTER)) {
    throw problem(400, "bad_play", "Unknown chapter.");
  }
  return { type, seconds, chapter: body.chapter || 0, saved: body.saved === true, longPlay: body.longPlay === true };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {number} min @param {number} max */
function clampInt(value, min, max) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

/** @param {number} status @param {string} code @param {string} message */
function problem(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

module.exports = { HumdingersService, MAX_SAVE_BYTES, MAX_SLOTS, MAX_ACTIVE_SECONDS };
