"use strict";

const { createHmac } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Humdingers account saves, daily play totals (ADR 0102) and play sessions
 * (ADR 0103).
 *
 * The /play/humdingers host page copies the game's localStorage saves
 * ("humdingers.save.<slot>", JSON with fmt "humdingers-save") to the
 * player's account and back. Play totals are one row per UTC day with no
 * user IDs; unique players are counted through a peppered per-day hash
 * that expires after 35 days. Each visit to the game page is also kept as a
 * play session with the account for 90 days, so admins can see who played,
 * when and for how long.
 *
 * @typedef {{userId: string, slot: string, data: string, when: number, playtime: number, chapter: number,
 *   world: string|null, updatedAt: Date}} HumdingersSaveDoc
 * @typedef {{_id: string, loads: number, activeSeconds: number, longPlays: number, uniquePlayers: number,
 *   savers: number, maxChapter: number, updatedAt: Date}} HumdingersPlayDayDoc
 * @typedef {{_id: string, day: string, saved: boolean, expiresAt: Date}} HumdingersPlayPlayerDoc
 * @typedef {{userId: string, session: string, startedAt: Date, lastAt: Date, loads: number, activeSeconds: number,
 *   maxChapter: number, saved: boolean, expiresAt: Date}} HumdingersPlaySessionDoc
 * @typedef {{startedAt: Date, lastAt: Date, activeSeconds: number, maxChapter: number, saved: boolean}} HumdingersSessionRow
 * @typedef {{userId: string, displayName: string|null, battleTag: string|null, email: string|null,
 *   sessions: number, activeSeconds: number, lastAt: Date|null, maxChapter: number,
 *   save: {slots: number, playtime: number, chapter: number, savedAt: Date|null}|null,
 *   recent: HumdingersSessionRow[]}} HumdingersPlayerRow
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
const DAY_MS = 86_400_000;
const PLAYER_TTL_MS = 35 * DAY_MS;
/** The host page's random id for one visit; reports without one share a per-day session. */
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Covers the longest admin range (90 UTC days, today included). */
const SESSION_TTL_MS = 90 * DAY_MS;
const MAX_PLAYERS = 200;
const MAX_PLAYER_SESSIONS = 50;
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
   * One host report: a game load, or active play seconds. It adds to the
   * anonymous daily totals and to the account's session for this visit.
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
    // $max keeps "saved" true once any report had a save (false < true in BSON).
    await this.db.humdingersPlaySessions.updateOne(
      { userId, session: play.session || `day-${day}` },
      {
        $inc: { loads: play.type === "load" ? 1 : 0, activeSeconds: play.seconds },
        $max: { lastAt: now, maxChapter: play.chapter, saved: play.saved },
        $setOnInsert: stampVersion({ startedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) }, COLLECTIONS.HUMDINGERS_PLAY_SESSIONS),
      },
      { upsert: true },
    );
  }

  /**
   * Admin totals for the trailing 7, 30 or 90 UTC days, newest first, and
   * the accounts that played in them.
   * @param {unknown} rawDays
   */
  async stats(rawDays) {
    const days = rawDays === undefined ? DEFAULT_STATS_DAYS : Number(rawDays);
    if (!STATS_DAYS.includes(days)) throw problem(400, "bad_range", "Choose 7, 30 or 90 days.");
    const today = Date.parse(`${this.now().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const keys = Array.from({ length: days }, (_, index) => new Date(today - index * DAY_MS).toISOString().slice(0, 10));
    const [rows, players] = await Promise.all([
      this.db.humdingersPlayDays.find({ _id: { $in: keys } }).toArray(),
      this.players(new Date(today - (days - 1) * DAY_MS)),
    ]);
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
      players: players.items,
      playersTruncated: players.truncated,
    };
  }

  /**
   * The accounts that played since `since`, most recent first, with their
   * sessions in the range (newest first) and a summary of the saves they
   * hold now. Accounts whose saves changed in the range are listed too,
   * which covers play from before sessions were recorded.
   * @param {Date} since
   * @returns {Promise<{items: HumdingersPlayerRow[], truncated: boolean}>}
   */
  async players(since) {
    const played = await this.db.humdingersPlaySessions.aggregate([
      { $match: { startedAt: { $gte: since } } },
      {
        $group: {
          _id: "$userId",
          sessions: { $sum: 1 },
          activeSeconds: { $sum: "$activeSeconds" },
          lastAt: { $max: "$lastAt" },
          maxChapter: { $max: "$maxChapter" },
          recent: {
            $topN: {
              n: MAX_PLAYER_SESSIONS,
              sortBy: { startedAt: -1 },
              output: { startedAt: "$startedAt", lastAt: "$lastAt", activeSeconds: "$activeSeconds", maxChapter: "$maxChapter", saved: "$saved" },
            },
          },
        },
      },
      { $sort: { lastAt: -1, _id: 1 } },
      { $limit: MAX_PLAYERS + 1 },
    ], { maxTimeMS: 10_000 }).toArray();
    const sessionIds = played.slice(0, MAX_PLAYERS).map((row) => String(row._id));
    const savers = (await this.db.humdingersSaves.distinct("userId", { updatedAt: { $gte: since } }))
      .filter((id) => !sessionIds.includes(id));
    const ids = [...sessionIds, ...savers].slice(0, MAX_PLAYERS);
    const truncated = played.length > MAX_PLAYERS || sessionIds.length + savers.length > MAX_PLAYERS;
    if (ids.length === 0) return { items: [], truncated: false };
    const [users, saves] = await Promise.all([
      this.db.users.find({ userId: { $in: ids } }, { projection: { _id: 0, userId: 1, email: 1, displayName: 1, battleTag: 1, battleTags: 1 } }).toArray(),
      this.db.humdingersSaves.aggregate([
        { $match: { userId: { $in: ids } } },
        { $group: { _id: "$userId", slots: { $sum: 1 }, playtime: { $max: "$playtime" }, chapter: { $max: "$chapter" }, savedAt: { $max: "$updatedAt" } } },
      ], { maxTimeMS: 10_000 }).toArray(),
    ]);
    const userById = new Map(users.map((user) => [user.userId, user]));
    const saveById = new Map(saves.map((save) => [save._id, save]));
    const playedById = new Map(played.map((row) => [row._id, row]));
    const items = ids.map((userId) => playerRow(userId, userById.get(userId), playedById.get(userId), saveById.get(userId)));
    items.sort((a, b) => lastSeen(b) - lastSeen(a));
    return { items, truncated };
  }
}

/**
 * @param {string} userId @param {any} user @param {any} played @param {any} save
 * @returns {HumdingersPlayerRow}
 */
function playerRow(userId, user, played, save) {
  const tags = Array.isArray(user?.battleTags) ? user.battleTags : [];
  return {
    userId,
    displayName: text(user?.displayName),
    battleTag: text(user?.battleTag) || text(tags[0]),
    email: text(user?.email),
    sessions: played?.sessions || 0,
    activeSeconds: played?.activeSeconds || 0,
    lastAt: dateOrNull(played?.lastAt),
    maxChapter: played?.maxChapter || 0,
    save: save ? { slots: save.slots || 0, playtime: save.playtime || 0, chapter: save.chapter || 0, savedAt: dateOrNull(save.savedAt) } : null,
    recent: (played?.recent || []).map((/** @type {any} */ row) => ({
      startedAt: row.startedAt,
      lastAt: row.lastAt,
      activeSeconds: row.activeSeconds || 0,
      maxChapter: row.maxChapter || 0,
      saved: row.saved === true,
    })),
  };
}

/** The newest session report or save upload. @param {HumdingersPlayerRow} row */
function lastSeen(row) {
  return Math.max(row.lastAt?.getTime() || 0, row.save?.savedAt?.getTime() || 0);
}

/** @param {unknown} value @returns {string|null} */
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

/** @param {unknown} value @returns {Date|null} */
function dateOrNull(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
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
  // Pages opened before sessions existed send no id; they share a per-day session.
  if (body.session !== undefined && (typeof body.session !== "string" || !SESSION_RE.test(body.session))) {
    throw problem(400, "bad_play", "Unknown play session.");
  }
  /** @type {string|null} */
  const session = body.session || null;
  return { type, seconds, chapter: body.chapter || 0, saved: body.saved === true, longPlay: body.longPlay === true, session };
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
