"use strict";

const { createHmac } = require("crypto");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Humdingers account saves, daily play totals (ADR 0102), play sessions
 * (ADR 0103) and run tapes (ADR 0113).
 *
 * The /play/humdingers host page copies the game's localStorage saves
 * ("humdingers.save.<slot>", JSON with fmt "humdingers-save") to the
 * player's account and back. Play totals are one row per UTC day with no
 * user IDs; unique players are counted through a peppered per-day hash
 * that expires after 35 days. Each visit to the game page is also kept as a
 * play session with the account for 90 days, so admins can see who played,
 * when and for how long. The host page also uploads the visit's run tape
 * (button presses and a few storage reads: a deterministic replay log) in
 * numbered chunks under the same session id. Each chunk is kept with the
 * account for 90 days, the visit's tape totals live on its session row, and
 * admins replay the tape from the admin page.
 *
 * @typedef {{userId: string, slot: string, data: string, when: number, playtime: number, chapter: number,
 *   world: string|null, updatedAt: Date}} HumdingersSaveDoc
 * @typedef {{_id: string, loads: number, activeSeconds: number, longPlays: number, uniquePlayers: number,
 *   savers: number, maxChapter: number, updatedAt: Date}} HumdingersPlayDayDoc
 * @typedef {{_id: string, day: string, saved: boolean, expiresAt: Date}} HumdingersPlayPlayerDoc
 * @typedef {{ticks?: number, maps?: number, fights?: number, won?: number, lost?: number, ran?: number, overs?: number,
 *   levelups?: number, saves?: number, hints?: number, goal?: string}} HumdingersTapeSummary
 * @typedef {{build: string, chunks: number, bytes: number, ticks: number, final?: boolean, summary?: HumdingersTapeSummary,
 *   updatedAt: Date}} HumdingersTapeTotalsDoc
 * @typedef {{userId: string, session: string, startedAt: Date, lastAt: Date, loads: number, activeSeconds: number,
 *   maxChapter: number, saved: boolean, expiresAt: Date, tape?: HumdingersTapeTotalsDoc}} HumdingersPlaySessionDoc
 * @typedef {{userId: string, session: string, seq: number, enc: "gzip-b64"|"json", data: string, bytes: number,
 *   build: string, from: number, to: number, createdAt: Date, expiresAt: Date}} HumdingersTapeChunkDoc
 * @typedef {{build: string, chunks: number, bytes: number, ticks: number, final: boolean,
 *   summary: HumdingersTapeSummary|null}} HumdingersTapeTotals
 * @typedef {{session: string, startedAt: Date, lastAt: Date, activeSeconds: number, maxChapter: number, saved: boolean,
 *   tape: HumdingersTapeTotals|null}} HumdingersSessionRow
 * @typedef {{userId: string, displayName: string|null, battleTag: string|null, email: string|null,
 *   sessions: number, activeSeconds: number, lastAt: Date|null, maxChapter: number,
 *   save: {slots: number, playtime: number, chapter: number, savedAt: Date|null}|null,
 *   recent: HumdingersSessionRow[]}} HumdingersPlayerRow
 * @typedef {{seq: number, enc: "gzip-b64"|"json", data: string, from: number, to: number}} HumdingersTapeChunk
 * @typedef {{userId: string, session: string, build: string, ticks: number, bytes: number, final: boolean,
 *   summary: HumdingersTapeSummary|null, startedAt: Date|null, lastAt: Date|null, chunks: HumdingersTapeChunk[]}} HumdingersTape
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
/** A tape chunk is gzipped JSON in base64, or plain JSON. */
const TAPE_ENCODINGS = ["gzip-b64", "json"];
/** Standard or URL-safe base64: all a gzip-b64 chunk may hold. */
const TAPE_BASE64_RE = /^[A-Za-z0-9+/=_-]*$/;
/** The game build that recorded the tape. */
const TAPE_BUILD_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** Chunks are numbered from 0 within one visit. */
const MAX_TAPE_SEQ = 9999;
/** As base64, a full chunk and its fields fit the API's 256 kB body limit. */
const MAX_TAPE_CHUNK_CHARS = 200_000;
/** The furthest game tick a chunk may reach. */
const MAX_TAPE_TICK = 50_000_000;
/** One visit's tape keeps at most this many chunks. */
const MAX_TAPE_CHUNKS = 2000;
/** One visit's tape keeps at most this many characters of chunk data. */
const MAX_TAPE_BYTES = 8_000_000;
/** The summary counters kept; other summary fields, except the goal, are dropped. */
const TAPE_SUMMARY_COUNTS = /** @type {const} */ (["ticks", "maps", "fights", "won", "lost", "ran", "overs", "levelups", "saves", "hints"]);
/** Summary counters are clamped to 0..this. */
const MAX_TAPE_COUNT = 10_000_000;
/** The summary's goal text is clipped to this many characters. */
const MAX_TAPE_GOAL_CHARS = 120;
/** Account ids are UUIDs; the admin tape read refuses anything longer. */
const MAX_USER_ID_CHARS = 64;

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
   * Stores one chunk of a visit's run tape (ADR 0113) and adds it to the
   * tape totals on the visit's session row. A retried chunk hits the unique
   * {userId, session, seq} index and is not counted again. The caps are
   * checked before the insert, so uploads sent at the same time could each
   * pass them by one chunk; the host page sends one chunk at a time.
   * @param {string} userId @param {unknown} session @param {any} body
   */
  async putTapeChunk(userId, session, body) {
    const chunk = parseTapeChunk(session, body);
    const key = { userId, session: chunk.session };
    const row = await this.db.humdingersPlaySessions.findOne(key, { projection: { _id: 0, tape: 1 } });
    const bytes = chunk.data.length;
    if ((row?.tape?.chunks || 0) >= MAX_TAPE_CHUNKS || (row?.tape?.bytes || 0) + bytes > MAX_TAPE_BYTES) {
      throw problem(413, "tape_full", "This visit's tape is full.");
    }
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const { seq, enc, data, build, from, to } = chunk;
    try {
      await this.db.humdingersTapeChunks.insertOne(stampVersion(
        { ...key, seq, enc, data, bytes, build, from, to, createdAt: now, expiresAt },
        COLLECTIONS.HUMDINGERS_TAPE_CHUNKS,
      ));
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 11000) throw error;
      // A retry of a chunk already stored and counted counts nothing again, but a page-exit retry may be the one that says the
      // tape is final, and its summary is the newest.
      /** @type {Record<string, any>} */
      const late = {};
      if (chunk.summary) late["tape.summary"] = chunk.summary;
      if (chunk.final) late["tape.final"] = true;
      if (Object.keys(late).length) await this.db.humdingersPlaySessions.updateOne(key, { $set: late });
      return;
    }
    /** @type {Record<string, any>} */
    const set = { "tape.build": build, "tape.updatedAt": now };
    if (chunk.summary) set["tape.summary"] = chunk.summary;
    if (chunk.final) set["tape.final"] = true;
    // A tape that arrives before the visit's first play report starts the
    // row with the same defaults recordPlay gives a new session.
    await this.db.humdingersPlaySessions.updateOne(
      key,
      {
        $inc: { "tape.chunks": 1, "tape.bytes": bytes },
        $max: { "tape.ticks": to },
        $set: set,
        $setOnInsert: stampVersion(
          { startedAt: now, lastAt: now, loads: 0, activeSeconds: 0, maxChapter: 0, saved: false, expiresAt },
          COLLECTIONS.HUMDINGERS_PLAY_SESSIONS,
        ),
      },
      { upsert: true },
    );
  }

  /**
   * One visit's run tape for the admin replay (ADR 0113): its chunks in
   * sequence order. Build, ticks and bytes come from those chunks, so they
   * match what is returned; the final flag, summary and times come from the
   * visit's session row.
   * @param {unknown} userId @param {unknown} session
   * @returns {Promise<HumdingersTape>}
   */
  async tape(userId, session) {
    if (typeof userId !== "string" || !userId || userId.length > MAX_USER_ID_CHARS) {
      throw problem(400, "bad_user", "Unknown account.");
    }
    const key = { userId, session: parseSession(session) };
    const [chunks, row] = await Promise.all([
      this.db.humdingersTapeChunks
        .find(key, { projection: { _id: 0, seq: 1, enc: 1, data: 1, build: 1, from: 1, to: 1 } })
        .sort({ seq: 1 })
        .limit(MAX_TAPE_SEQ + 1)
        .toArray(),
      this.db.humdingersPlaySessions.findOne(key, { projection: { _id: 0, startedAt: 1, lastAt: 1, tape: 1 } }),
    ]);
    if (chunks.length === 0) throw problem(404, "not_found", "This visit has no tape.");
    return {
      userId: key.userId,
      session: key.session,
      build: chunks[chunks.length - 1].build,
      ticks: chunks.reduce((max, chunk) => Math.max(max, chunk.to), 0),
      bytes: chunks.reduce((total, chunk) => total + chunk.data.length, 0),
      final: row?.tape?.final === true,
      summary: row?.tape?.summary || null,
      startedAt: dateOrNull(row?.startedAt),
      lastAt: dateOrNull(row?.lastAt),
      chunks: chunks.map((chunk) => ({ seq: chunk.seq, enc: chunk.enc, data: chunk.data, from: chunk.from, to: chunk.to })),
    };
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
   * sessions in the range (newest first, each with its tape totals) and a
   * summary of the saves they hold now. Accounts whose saves changed in the
   * range are listed too, which covers play from before sessions were
   * recorded.
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
              output: {
                session: "$session", startedAt: "$startedAt", lastAt: "$lastAt", activeSeconds: "$activeSeconds",
                maxChapter: "$maxChapter", saved: "$saved", tape: "$tape",
              },
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
      session: String(row.session),
      startedAt: row.startedAt,
      lastAt: row.lastAt,
      activeSeconds: row.activeSeconds || 0,
      maxChapter: row.maxChapter || 0,
      saved: row.saved === true,
      tape: tapeTotals(row.tape),
    })),
  };
}

/** A session's tape totals, or null when the visit has no tape. @param {any} tape @returns {HumdingersTapeTotals|null} */
function tapeTotals(tape) {
  if (!tape || typeof tape !== "object") return null;
  return {
    build: typeof tape.build === "string" ? tape.build : "",
    chunks: tape.chunks || 0,
    bytes: tape.bytes || 0,
    ticks: tape.ticks || 0,
    final: tape.final === true,
    summary: tape.summary || null,
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

/** The host page's id for one visit. @param {unknown} session @returns {string} */
function parseSession(session) {
  if (typeof session !== "string" || !SESSION_RE.test(session)) throw problem(400, "bad_session", "Unknown play session.");
  return session;
}

/** @param {unknown} session @param {any} body */
function parseTapeChunk(session, body) {
  const id = parseSession(session);
  const bad = (/** @type {string} */ message) => problem(400, "bad_tape_chunk", message);
  if (!isObject(body)) throw bad("Send the tape chunk as JSON.");
  const { seq, enc, data, build, from, to, final, summary } = /** @type {Record<string, any>} */ (body);
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_TAPE_SEQ) throw bad(`Number the chunk 0 to ${MAX_TAPE_SEQ}.`);
  if (!TAPE_ENCODINGS.includes(enc)) throw bad("Unknown tape encoding.");
  if (typeof data !== "string" || !data || data.length > MAX_TAPE_CHUNK_CHARS) {
    throw bad(`Send 1 to ${MAX_TAPE_CHUNK_CHARS} characters of tape.`);
  }
  if (enc === "gzip-b64" && !TAPE_BASE64_RE.test(data)) throw bad("The tape chunk is not base64.");
  if (typeof build !== "string" || !TAPE_BUILD_RE.test(build)) throw bad("Unknown game build.");
  if (!isTick(from) || !isTick(to) || to < from) throw bad("Unknown tick range.");
  // The optional fields may also be sent as null.
  if (final != null && typeof final !== "boolean") throw bad("Mark the last chunk with final: true.");
  if (summary != null && !isObject(summary)) throw bad("Send the summary as an object.");
  return {
    session: id, seq, enc, data, build, from, to,
    final: final === true,
    summary: summary == null ? null : parseTapeSummary(summary),
  };
}

/** @param {unknown} value @returns {value is number} */
function isTick(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_TAPE_TICK;
}

/**
 * Keeps the known counters, clamped, and the goal text, clipped; drops
 * every other field.
 * @param {Record<string, unknown>} raw @returns {HumdingersTapeSummary}
 */
function parseTapeSummary(raw) {
  /** @type {HumdingersTapeSummary} */
  const summary = {};
  for (const field of TAPE_SUMMARY_COUNTS) {
    const value = raw[field];
    if (typeof value === "number" && Number.isInteger(value)) summary[field] = Math.min(MAX_TAPE_COUNT, Math.max(0, value));
  }
  if (typeof raw.goal === "string") summary.goal = raw.goal.slice(0, MAX_TAPE_GOAL_CHARS);
  return summary;
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

module.exports = {
  HumdingersService, MAX_SAVE_BYTES, MAX_SLOTS, MAX_ACTIVE_SECONDS, MAX_TAPE_CHUNK_CHARS, MAX_TAPE_CHUNKS, MAX_TAPE_BYTES,
};
