"use strict";

const { ObjectId } = require("mongodb");
const { COLLECTIONS, LIMITS } = require("../config/constants");
const { expectedVersion, stampVersion } = require("../db/schemaVersioning");
const {
  enforceNoteInvariants,
  normalizeGamePoint,
  normalizeNoteText,
  normalizeReview,
  normalizeTags,
  streamEligible,
} = require("./notesPolicy");

/** Legacy rows moved per round trip; a large account drains in many batches. */
const MIGRATION_BATCH = 200;
/** Player-scope notes read for one opponent (dossier) / shipped live. */
const LINKED_NOTES_MAX = 10;
const LIVE_LINKED_NOTES_MAX = 3;
/** Owner search: at most this many games matched through note text. */
const NOTE_SEARCH_GAMES_MAX = 500;
const ORPHAN_BATCH = 500;
const QUERY_DEADLINE_MS = 2000;
const NOTE_ID = /^[a-f0-9]{24}$/;
const NOTES_VERSION = expectedVersion(COLLECTIONS.NOTES);

/** Legacy rows the migration can move: a non-blank account id and string text. */
const LEGACY_FILTER = Object.freeze({ pulseId: { $type: "string", $regex: /\S/ }, notes: { $type: "string" } });
const NOTE_PROJECTION = Object.freeze({
  _id: 1, target: 1, text: 1, tags: 1, visibility: 1, scope: 1, groupKey: 1, pinned: 1,
  readAloud: 1, gameTimeSec: 1, x: 1, y: 1, migratedFrom: 1, createdAt: 1, updatedAt: 1,
});
const LIVE_GAME = Object.freeze({ _deleted: { $ne: true }, _deletionPending: { $ne: true } });

/**
 * The notes collection's indexes: target reads (a game's notes, one
 * opponent's note), player-scope reads by group key, and the one-note-per-
 * opponent-account slot that makes the migration's upserts idempotent.
 */
const NOTES_INDEXES = Object.freeze([
  { key: { userId: 1, "target.kind": 1, "target.id": 1 }, options: { name: "notes_target" } },
  { key: { userId: 1, groupKey: 1 }, options: { name: "notes_group", partialFilterExpression: { groupKey: { $type: "string" } } } },
  {
    key: { userId: 1, "target.id": 1, "target.kind": 1 },
    options: { name: "notes_opponent_unique", unique: true, partialFilterExpression: { "target.kind": "opponent" } },
  },
]);

/** @param {import('mongodb').Collection} collection */
async function ensureNotesIndexes(collection) {
  for (const { key, options } of NOTES_INDEXES) await collection.createIndex(/** @type {any} */ (key), /** @type {any} */ (options));
}

/**
 * @typedef {{
 *   _id?: import('mongodb').ObjectId,
 *   userId?: string,
 *   target: {kind: "opponent"|"game", id: string},
 *   text: string,
 *   tags?: string[],
 *   visibility?: "stream"|"private",
 *   scope?: "account"|"player",
 *   groupKey?: string|null,
 *   pinned?: boolean,
 *   readAloud?: boolean,
 *   gameTimeSec?: number|null,
 *   x?: number|null,
 *   y?: number|null,
 *   migratedFrom?: string,
 *   createdAt?: Date,
 *   updatedAt?: Date,
 * }} NoteDoc
 *
 * @typedef {{
 *   groupKey?: string|null,
 *   pulseIds?: string[],
 *   identities?: Array<{pulseId?: string, displayNameSample?: string, revealedName?: string}>,
 * }} LinkedIdentity  ScoutingIdentitiesService.resolve output (subset)
 */

/** @param {string} code @param {number} status @param {string} [message] */
function failure(code, status, message) {
  return Object.assign(new Error(message || code), { code, status });
}

/**
 * A stored identifier, matched exactly (opponents ``pulseId``, games
 * ``gameId``): never trimmed or truncated, so it always names the same row.
 * @param {unknown} value
 */
function cleanId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : "";
}

/** @param {unknown} value @returns {string} */
function isoDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : "";
}

/**
 * Owner-facing note DTO. Built field by field; never spread a Mongo row.
 * @param {NoteDoc} doc
 */
function serializeNote(doc) {
  const game = doc.target?.kind === "game";
  return {
    id: doc._id ? String(doc._id) : "",
    target: { kind: doc.target.kind, id: doc.target.id },
    text: typeof doc.text === "string" ? doc.text : "",
    tags: Array.isArray(doc.tags) ? doc.tags.filter((tag) => typeof tag === "string") : [],
    visibility: game ? "private" : doc.visibility === "stream" ? "stream" : "private",
    scope: !game && doc.scope === "player" ? "player" : "account",
    pinned: doc.pinned === true,
    readAloud: !game && doc.readAloud === true,
    streamEligible: !game && streamEligible(doc),
    migrated: doc.migratedFrom === "opponent_notes",
    ...(game ? {
      gameTimeSec: typeof doc.gameTimeSec === "number" ? doc.gameTimeSec : null,
      x: typeof doc.x === "number" ? doc.x : null,
      y: typeof doc.y === "number" ? doc.y : null,
    } : {}),
    createdAt: isoDate(doc.createdAt),
    updatedAt: isoDate(doc.updatedAt),
  };
}

/** @param {unknown} err */
function duplicateKeyOnly(err) {
  const e = /** @type {any} */ (err);
  if (e?.code === 11000) return true;
  const errors = e?.writeErrors || e?.result?.result?.writeErrors;
  const list = Array.isArray(errors) ? errors : errors ? [errors] : [];
  return list.length > 0 && list.every((item) => (item?.code ?? item?.err?.code) === 11000);
}

/** @param {string} value */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One private notes system for opponents and games.
 *
 * Opponent notes: at most one note per exact account (``target.id`` is the
 * opponents row ``pulseId``), with tags, stream/private visibility and an
 * account/player scope. Game notes: up to ``GAME_NOTES_MAX`` private notes
 * per game, each at an optional game time and map point. The game row keeps
 * a ``noteCount`` for the "Has notes" filter and a small ``review``
 * subdocument for the review queue.
 *
 * Legacy ``opponent_notes`` rows move into this collection the first time a
 * user's notes are read or written (``ensureMigrated``): bounded batches,
 * idempotent upserts that never overwrite a newer note, and the legacy row is
 * removed only after its copy exists. Malformed legacy rows stay untouched.
 */
class NotesService {
  /**
   * @param {Pick<import('../db/connect').DbContext, 'notes'|'opponentNotes'|'games'> & Partial<import('../db/connect').DbContext>} db
   * @param {{
   *   scoutingIdentities?: {resolve: (userId: string, doc: any, allowMerge?: boolean) => Promise<LinkedIdentity>}|null,
   *   logger?: {warn?: Function, info?: Function}|null,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.scoutingIdentities = opts.scoutingIdentities || null;
    this.logger = opts.logger || null;
    /** @type {Map<string, Promise<number>>} */
    this._migrations = new Map();
    /** @type {Map<string, Promise<void>>} */
    this._gameNoteWrites = new Map();
  }

  /* ------------------------------------------------------------------
   * Migration
   * ------------------------------------------------------------------ */

  /**
   * Move this user's legacy opponent notes, if any remain. A no-op after the
   * first call is one indexed point read. Concurrent calls share one run.
   *
   * @param {string} userId
   * @returns {Promise<number>} legacy notes moved by this call
   */
  async ensureMigrated(userId) {
    if (!userId || !this.db.opponentNotes || !this.db.notes) return 0;
    const pending = this._migrations.get(userId);
    if (pending) return pending;
    const run = this._migrateUser(userId).finally(() => this._migrations.delete(userId));
    this._migrations.set(userId, run);
    return run;
  }

  /** @param {string} userId */
  async _migrateUser(userId) {
    const legacy = /** @type {import('mongodb').Collection} */ (this.db.opponentNotes);
    let moved = 0;
    /** @type {any} */
    let after = null;
    for (;;) {
      const batch = await legacy
        .find({ userId, ...LEGACY_FILTER, ...(after ? { _id: { $gt: after } } : {}) },
          { projection: { _id: 1, pulseId: 1, notes: 1, notesReadAloud: 1, updatedAt: 1 } })
        .sort({ _id: 1 })
        .limit(MIGRATION_BATCH)
        .toArray();
      if (batch.length === 0) return moved;
      after = batch[batch.length - 1]._id;
      /** @type {any[]} */
      const ops = [];
      for (const row of batch) {
        // The exact stored account id: it must keep matching the opponents row.
        const pulseId = String(row.pulseId);
        const text = String(row.notes).trim();
        if (!text) continue;
        const at = row.updatedAt instanceof Date ? row.updatedAt : row._id?.getTimestamp?.() || new Date();
        ops.push({
          updateOne: {
            filter: { userId, "target.kind": "opponent", "target.id": pulseId },
            // $setOnInsert only: a note already written in the new system is
            // newer user intent and is never overwritten.
            update: {
              // userId and target come from the filter's equality clauses.
              $setOnInsert: stampVersion({
                text,
                tags: [],
                // Notes always appeared on the scouting widget before this
                // system existed; keep that until the owner changes it.
                visibility: "stream",
                scope: "account",
                pinned: false,
                readAloud: row.notesReadAloud === true,
                migratedFrom: "opponent_notes",
                createdAt: at,
                updatedAt: at,
              }, COLLECTIONS.NOTES),
            },
            upsert: true,
          },
        });
      }
      if (ops.length) {
        try { await this.db.notes.bulkWrite(ops, { ordered: false }); }
        catch (err) { if (!duplicateKeyOnly(err)) throw err; }
      }
      // Each copy now exists (inserted, or a newer note already held the
      // slot), so removing the source rows cannot lose a note.
      await legacy.deleteMany({ userId, _id: { $in: batch.map((row) => row._id) } });
      moved += ops.length;
    }
  }

  /**
   * Operator sweep: migrate every user with legacy rows, in bounded batches.
   * @param {{maxUsers?: number}} [opts]
   * @returns {Promise<{users: number, notes: number}>}
   */
  async migrateAll(opts = {}) {
    const maxUsers = Number.isSafeInteger(opts.maxUsers) && /** @type {number} */ (opts.maxUsers) > 0 ? /** @type {number} */ (opts.maxUsers) : Infinity;
    const userIds = this.db.opponentNotes
      ? (await this.db.opponentNotes.distinct("userId", LEGACY_FILTER)).filter((id) => typeof id === "string" && id)
      : [];
    let users = 0;
    let notes = 0;
    for (const userId of userIds) {
      if (users >= maxUsers) break;
      notes += await this.ensureMigrated(userId);
      users += 1;
    }
    return { users, notes };
  }

  /* ------------------------------------------------------------------
   * Opponent notes
   * ------------------------------------------------------------------ */

  /**
   * @param {string} userId
   * @param {string} pulseId
   * @returns {Promise<NoteDoc|null>}
   */
  async opponentNote(userId, pulseId) {
    await this.ensureMigrated(userId);
    return /** @type {NoteDoc|null} */ (await this.db.notes.findOne(
      { userId, "target.kind": "opponent", "target.id": pulseId },
      { projection: NOTE_PROJECTION },
    ));
  }

  /**
   * Notes for several opponent rows in one indexed read.
   * @param {string} userId
   * @param {string[]} pulseIds
   * @returns {Promise<Map<string, NoteDoc>>}
   */
  async opponentNotesFor(userId, pulseIds) {
    const ids = [...new Set(pulseIds.filter((id) => typeof id === "string" && id))];
    /** @type {Map<string, NoteDoc>} */
    const out = new Map();
    if (!ids.length) return out;
    await this.ensureMigrated(userId);
    const cursor = this.db.notes.find(
      { userId, "target.kind": "opponent", "target.id": { $in: ids } },
      { projection: { _id: 0, target: 1, text: 1, tags: 1, visibility: 1, scope: 1 } },
    );
    for await (const doc of cursor) {
      if ((typeof doc.text === "string" && doc.text.trim()) || (Array.isArray(doc.tags) && doc.tags.length)) {
        out.set(doc.target.id, /** @type {NoteDoc} */ (doc));
      }
    }
    return out;
  }

  /**
   * Save the owner's note on one account, or delete it when empty of text and tags.
   * Omitted fields keep their stored value. A legacy client that asks for
   * read-aloud is asking for a stream note, so that also sets visibility.
   *
   * @param {string} userId
   * @param {{pulseId: string, pulseCharacterId?: string|null, toonHandle?: string|null}} opponent
   *   the owner's opponents row (identity fields only)
   * @param {{
   *   text: string,
   *   tags?: string[],
   *   visibility?: "stream"|"private",
   *   scope?: "account"|"player",
   *   pinned?: boolean,
   *   readAloud?: boolean,
   *   preserveReadAloud?: boolean,
   * }} input validated by the route
   * @returns {Promise<NoteDoc|null>} the saved note, or null when deleted
   */
  async saveOpponentNote(userId, opponent, input) {
    const pulseId = cleanId(opponent?.pulseId);
    const text = normalizeNoteText(input?.text);
    if (!pulseId || text === null || text.length > LIMITS.NOTE_TEXT_MAX_LENGTH) throw failure("bad_request", 400, "invalid note");
    const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
    if (tags?.error !== undefined) throw failure("bad_request", 400, tags.error);
    await this.ensureMigrated(userId);
    const filter = { userId, "target.kind": "opponent", "target.id": pulseId };
    const clearTextOnly = !text && tags === undefined;
    if (!text && !tags?.tags?.length) {
      // Quick editors omit tags. Only delete if the row still has none.
      const deleteFilter = clearTextOnly ? { ...filter, "tags.0": { $exists: false } } : filter;
      const { deletedCount } = await this.db.notes.deleteOne(deleteFilter);
      if (!clearTextOnly || deletedCount) return null;
    }
    const existing = /** @type {NoteDoc|null} */ (await this.db.notes.findOne(filter, { projection: NOTE_PROJECTION }));
    if (clearTextOnly && !existing?.tags?.length) return null;
    const legacySpeak = input.visibility === undefined && input.preserveReadAloud !== true && input.readAloud === true;
    const fields = enforceNoteInvariants({
      tags: tags?.tags ?? existing?.tags ?? [],
      visibility: legacySpeak ? "stream" : input.visibility ?? existing?.visibility ?? "private",
      readAloud: Boolean(text) && (input.preserveReadAloud === true ? existing?.readAloud === true : input.readAloud === true),
    });
    const scope = input.scope ?? existing?.scope ?? "account";
    const groupKey = scope === "player" ? await this._groupKey(userId, opponent) : null;
    const now = new Date();
    const update = {
      $set: {
        text,
        ...(clearTextOnly ? {} : { tags: fields.tags }),
        visibility: fields.visibility,
        readAloud: fields.readAloud,
        scope,
        pinned: input.pinned ?? existing?.pinned ?? false,
        updatedAt: now,
        ...(groupKey ? { groupKey } : {}),
        _schemaVersion: NOTES_VERSION,
      },
      $setOnInsert: { createdAt: now },
      ...(groupKey ? {} : { $unset: { groupKey: "" } }),
    };
    // A text-only clear must not recreate a concurrently deleted note or restore its tags.
    const writeFilter = clearTextOnly ? { ...filter, "tags.0": { $exists: true } } : filter;
    const write = () => this.db.notes.findOneAndUpdate(writeFilter, update, {
      upsert: !clearTextOnly, returnDocument: "after", projection: NOTE_PROJECTION, includeResultMetadata: false,
    });
    try { return /** @type {NoteDoc|null} */ (await write()); }
    catch (err) {
      // Two first writes raced on the unique slot; the loser updates it.
      if (!duplicateKeyOnly(err)) throw err;
      return /** @type {NoteDoc|null} */ (await write());
    }
  }

  /**
   * The player's group key for a player-scope note: an approved identity
   * group or a cached Pulse account link. Null when the player is not
   * linked (or the owner turned player grouping off).
   * @param {string} userId
   * @param {{pulseId: string, pulseCharacterId?: string|null, toonHandle?: string|null}} opponent
   */
  async _groupKey(userId, opponent) {
    if (!this.scoutingIdentities) return null;
    try {
      const linked = await this.scoutingIdentities.resolve(userId, opponent);
      const key = linked?.groupKey;
      return typeof key === "string" && key && !key.startsWith("single:") && key.length <= 200 ? key : null;
    } catch { return null; }
  }

  /**
   * Notes that apply to one opponent account: its own note first, then
   * player-scope notes written on the same player's other accounts (by
   * linked account or group key), pinned first, newest first.
   *
   * @param {string} userId
   * @param {string} pulseId the exact account
   * @param {LinkedIdentity|null} [linked]
   * @param {number} [max] linked notes to return
   * @returns {Promise<{note: NoteDoc|null, linked: Array<NoteDoc & {account?: string}>}>}
   */
  async forOpponent(userId, pulseId, linked = null, max = LINKED_NOTES_MAX) {
    const id = cleanId(pulseId);
    if (!userId || !id) return { note: null, linked: [] };
    await this.ensureMigrated(userId);
    const linkedIds = [...new Set((linked?.pulseIds || []).filter((value) => typeof value === "string" && value && value !== id))].slice(0, 20);
    const groupKey = typeof linked?.groupKey === "string" && !linked.groupKey.startsWith("single:") ? linked.groupKey : null;
    /** @type {any[]} */
    const branches = [];
    if (linkedIds.length) branches.push({ "target.id": { $in: linkedIds } });
    if (groupKey) branches.push({ groupKey });
    const [note, others] = await Promise.all([
      this.db.notes.findOne({ userId, "target.kind": "opponent", "target.id": id }, { projection: NOTE_PROJECTION }),
      branches.length
        ? this.db.notes.find(
          { userId, "target.kind": "opponent", scope: "player", "target.id": { $ne: id }, $or: branches },
          { projection: NOTE_PROJECTION, maxTimeMS: QUERY_DEADLINE_MS },
        ).sort({ pinned: -1, updatedAt: -1 }).limit(max).toArray()
        : Promise.resolve([]),
    ]);
    const names = new Map((linked?.identities || []).map((row) => [row?.pulseId, String(row?.displayNameSample || row?.revealedName || "").trim().slice(0, 120)]));
    return {
      note: /** @type {NoteDoc|null} */ (note),
      linked: /** @type {NoteDoc[]} */ (others).map((doc) => ({ ...doc, ...(names.get(doc.target?.id) ? { account: names.get(doc.target?.id) } : {}) })),
    };
  }

  /**
   * The live payload's two note views. ``stream`` is the single note the
   * OBS overlay may show (exact account first, then pinned/newest
   * player-scope notes); ``private`` carries every applicable note for the
   * owner's own surfaces and must never reach an overlay token.
   *
   * @param {string} userId
   * @param {string|null|undefined} pulseId
   * @param {LinkedIdentity|null} [linked]
   * @returns {Promise<{stream: {text: string, readAloud: boolean}|null, private: Record<string, any>|null}>}
   */
  async liveNotes(userId, pulseId, linked = null) {
    if (!userId || !pulseId) return { stream: null, private: null };
    let set;
    try { set = await this.forOpponent(userId, String(pulseId), linked, LIVE_LINKED_NOTES_MAX); }
    catch { return { stream: null, private: null }; }
    const chosen = [set.note, ...set.linked].find((doc) => streamEligible(doc)) || null;
    const brief = (/** @type {NoteDoc & {account?: string}} */ doc) => ({
      text: doc.text.trim().slice(0, LIMITS.NOTE_TEXT_MAX_LENGTH),
      tags: Array.isArray(doc.tags) ? doc.tags.slice(0, LIMITS.NOTE_TAGS_MAX) : [],
      visibility: streamEligible(doc) ? "stream" : "private",
      ...(doc.account ? { account: doc.account } : {}),
    });
    const hasAny = Boolean(set.note?.text?.trim()) || set.linked.length > 0;
    return {
      stream: chosen ? { text: chosen.text.trim(), readAloud: chosen.readAloud === true } : null,
      private: hasAny ? {
        note: set.note?.text?.trim() ? { ...brief(set.note), readAloud: set.note.readAloud === true && streamEligible(set.note) } : null,
        linked: set.linked.filter((doc) => doc.text?.trim()).map(brief),
      } : null,
    };
  }

  /* ------------------------------------------------------------------
   * Game notes
   * ------------------------------------------------------------------ */

  /**
   * Keep the note and its counter in one transaction where supported.
   * Standalone Mongo serializes the writes and count repair for each game in this process.
   * @template T
   * @param {string} userId @param {string} gameId
   * @param {(opts: {session?: import('mongodb').ClientSession}) => Promise<T>} write
   * @returns {Promise<T>}
   */
  async _withGameNoteWrite(userId, gameId, write) {
    if (this.db.gameStatsTransactions && this.db.client) {
      const session = this.db.client.startSession();
      try {
        return await session.withTransaction(() => write({ session }), { readConcern: { level: "snapshot" } });
      } finally {
        await session.endSession();
      }
    }
    const key = JSON.stringify([userId, gameId]);
    const previous = this._gameNoteWrites.get(key) || Promise.resolve();
    const current = previous.then(() => write({}));
    const tail = current.then(() => {}, () => {});
    this._gameNoteWrites.set(key, tail);
    try {
      return await current;
    } finally {
      if (this._gameNoteWrites.get(key) === tail) this._gameNoteWrites.delete(key);
    }
  }

  /** @param {string} userId @param {string} gameId @param {{session?: import('mongodb').ClientSession}} [opts] */
  async _liveGame(userId, gameId, opts = {}) {
    return this.db.games.findOne({ userId, gameId, ...LIVE_GAME }, { ...opts, projection: { _id: 0, gameId: 1, durationSec: 1, noteCount: 1 } });
  }

  /**
   * Every note on one game, earliest moment first (untimed notes last).
   * Heals the row's ``noteCount`` when it disagrees with the notes.
   * @param {string} userId
   * @param {string} gameId
   * @returns {Promise<{items: ReturnType<typeof serializeNote>[], limit: number}|null>}
   */
  async listGameNotes(userId, gameId) {
    const id = cleanId(gameId);
    const game = id ? await this._liveGame(userId, id) : null;
    if (!game) return null;
    const rows = await this.db.notes
      .find({ userId, "target.kind": "game", "target.id": id }, { projection: NOTE_PROJECTION })
      .limit(LIMITS.GAME_NOTES_MAX + 50)
      .toArray();
    rows.sort((a, b) => (a.gameTimeSec ?? Infinity) - (b.gameTimeSec ?? Infinity)
      || (a.createdAt?.getTime?.() || 0) - (b.createdAt?.getTime?.() || 0));
    if ((Number(game.noteCount) || 0) !== rows.length) await this._repairNoteCount(userId, id);
    return { items: rows.map((row) => serializeNote(/** @type {NoteDoc} */ (row))), limit: LIMITS.GAME_NOTES_MAX };
  }

  /** @param {string} userId @param {string} gameId */
  async _repairNoteCount(userId, gameId) {
    await this._withGameNoteWrite(userId, gameId, async (opts) => {
      const game = await this._liveGame(userId, gameId, opts);
      if (!game) return;
      const count = await this.db.notes.countDocuments({ userId, "target.kind": "game", "target.id": gameId }, opts);
      if ((Number(game.noteCount) || 0) === count) return;
      await this.db.games.updateOne({ userId, gameId, ...LIVE_GAME },
        count > 0 ? { $set: { noteCount: count } } : { $unset: { noteCount: "" } }, opts);
    });
  }

  /**
   * Validate a game note body.
   * @param {Record<string, unknown>} body
   * @param {{partial?: boolean, durationSec?: unknown}} opts
   */
  _gameNoteFields(body, opts) {
    /** @type {Record<string, any>} */
    const fields = {};
    if (!opts.partial || Object.hasOwn(body, "text")) {
      const text = normalizeNoteText(body.text);
      if (!text || text.length > LIMITS.NOTE_TEXT_MAX_LENGTH) throw failure("bad_request", 400, `text must contain 1 to ${LIMITS.NOTE_TEXT_MAX_LENGTH} characters`);
      fields.text = text;
    }
    if (!opts.partial || Object.hasOwn(body, "tags")) {
      const tags = normalizeTags(body.tags);
      if (tags.error !== undefined) throw failure("bad_request", 400, tags.error);
      fields.tags = tags.tags;
    }
    if (Object.hasOwn(body, "pinned")) {
      if (typeof body.pinned !== "boolean") throw failure("bad_request", 400, "pinned must be a boolean");
      fields.pinned = body.pinned;
    } else if (!opts.partial) fields.pinned = false;
    const point = normalizeGamePoint(body, { partial: opts.partial });
    if ("error" in point) throw failure("bad_request", 400, point.error);
    const duration = Number(opts.durationSec);
    if (typeof point.value.gameTimeSec === "number" && Number.isFinite(duration) && duration > 0 && point.value.gameTimeSec > duration + 1) {
      throw failure("bad_request", 400, "gameTimeSec is past the end of this game");
    }
    return { ...fields, ...point.value };
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @param {Record<string, unknown>} body
   */
  async createGameNote(userId, gameId, body) {
    const id = cleanId(gameId);
    return id ? this._withGameNoteWrite(userId, id, (opts) => this._createGameNote(userId, id, body, opts)) : null;
  }

  /**
   * @param {string} userId @param {string} id @param {Record<string, unknown>} body
   * @param {{session?: import('mongodb').ClientSession}} opts
   */
  async _createGameNote(userId, id, body, opts) {
    const game = await this._liveGame(userId, id, opts);
    if (!game) return null;
    const fields = this._gameNoteFields(body, { durationSec: game.durationSec });
    // The row's counter is the atomic cap: a slot is reserved before the
    // insert and released if the insert fails.
    const reserved = await this.db.games.updateOne(
      { userId, gameId: id, ...LIVE_GAME, noteCount: { $not: { $gte: LIMITS.GAME_NOTES_MAX } } },
      { $inc: { noteCount: 1 } }, opts,
    );
    if (!reserved.matchedCount) {
      if (!await this._liveGame(userId, id, opts)) return null;
      throw failure("game_notes_limit", 409, `A game can hold at most ${LIMITS.GAME_NOTES_MAX} notes.`);
    }
    const now = new Date();
    const doc = stampVersion({
      userId,
      target: { kind: "game", id },
      ...fields,
      visibility: "private",
      scope: "account",
      readAloud: false,
      createdAt: now,
      updatedAt: now,
    }, COLLECTIONS.NOTES);
    try {
      const { insertedId } = await this.db.notes.insertOne(doc, opts);
      return serializeNote(/** @type {NoteDoc} */ ({ ...doc, _id: insertedId }));
    } catch (err) {
      if (!opts.session) await this.db.games.updateOne({ userId, gameId: id, noteCount: { $gt: 0 } }, { $inc: { noteCount: -1 } }).catch(() => {});
      throw err;
    }
  }

  /**
   * @param {string} userId
   * @param {string} gameId
   * @param {string} noteId
   * @param {Record<string, unknown>} body
   */
  async updateGameNote(userId, gameId, noteId, body) {
    const id = cleanId(gameId);
    if (!id || typeof noteId !== "string" || !NOTE_ID.test(noteId)) return null;
    const game = await this._liveGame(userId, id);
    if (!game) return null;
    const fields = this._gameNoteFields(body, { partial: true, durationSec: game.durationSec });
    if (!Object.keys(fields).length) throw failure("bad_request", 400, "nothing to update");
    /** @type {Record<string, any>} */
    const set = { updatedAt: new Date() };
    /** @type {Record<string, string>} */
    const unset = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) unset[key] = "";
      else set[key] = value;
    }
    const saved = await this.db.notes.findOneAndUpdate(
      { _id: new ObjectId(noteId), userId, "target.kind": "game", "target.id": id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: "after", projection: NOTE_PROJECTION, includeResultMetadata: false },
    );
    return saved ? serializeNote(/** @type {NoteDoc} */ (saved)) : null;
  }

  /**
   * Delete one game note and return it, so the client can offer Undo by
   * creating it again.
   * @param {string} userId
   * @param {string} gameId
   * @param {string} noteId
   */
  async deleteGameNote(userId, gameId, noteId) {
    const id = cleanId(gameId);
    if (!id || typeof noteId !== "string" || !NOTE_ID.test(noteId)) return null;
    return this._withGameNoteWrite(userId, id, async (opts) => {
      const deleted = await this.db.notes.findOneAndDelete(
        { _id: new ObjectId(noteId), userId, "target.kind": "game", "target.id": id },
        { ...opts, projection: NOTE_PROJECTION, includeResultMetadata: false },
      );
      if (!deleted) return null;
      await this.db.games.updateOne({ userId, gameId: id, noteCount: { $gt: 0 } }, { $inc: { noteCount: -1 } }, opts);
      return serializeNote(/** @type {NoteDoc} */ (deleted));
    });
  }

  /**
   * Remove game notes whose game no longer exists (history wipes), checking
   * the games in bounded batches.
   * @param {string} userId
   * @returns {Promise<number>} notes removed
   */
  async deleteForMissingGames(userId) {
    if (!userId) return 0;
    let removed = 0;
    let after = "";
    for (;;) {
      const ids = (await this.db.notes.aggregate([
        { $match: { userId, "target.kind": "game", "target.id": { $gt: after } } },
        { $group: { _id: "$target.id" } },
        { $sort: { _id: 1 } },
        { $limit: ORPHAN_BATCH },
      ]).toArray()).map((row) => String(row._id));
      if (!ids.length) return removed;
      const live = new Set((await this.db.games
        .find({ userId, gameId: { $in: ids }, ...LIVE_GAME }, { projection: { _id: 0, gameId: 1 } })
        .toArray()).map((row) => row.gameId));
      const missing = ids.filter((gameId) => !live.has(gameId));
      if (missing.length) {
        const res = await this.db.notes.deleteMany({ userId, "target.kind": "game", "target.id": { $in: missing } });
        removed += res.deletedCount || 0;
      }
      after = ids[ids.length - 1];
      if (ids.length < ORPHAN_BATCH) return removed;
    }
  }

  /**
   * Games whose notes contain ``query`` (case-insensitive), for the owner's
   * replay search only. Bounded and deadline-limited.
   * @param {string} userId
   * @param {string} query already cleaned and length-capped by the caller
   * @returns {Promise<string[]>}
   */
  async gameIdsMatchingText(userId, query) {
    if (!userId || typeof query !== "string" || !query.trim()) return [];
    const pattern = new RegExp(escapeRegex(query.trim()), "i");
    const rows = await this.db.notes.aggregate([
      { $match: { userId, "target.kind": "game", text: pattern } },
      { $group: { _id: "$target.id" } },
      { $limit: NOTE_SEARCH_GAMES_MAX },
    ], { maxTimeMS: QUERY_DEADLINE_MS }).toArray();
    return rows.map((row) => String(row._id)).filter(Boolean);
  }

  /* ------------------------------------------------------------------
   * Review queue
   * ------------------------------------------------------------------ */

  /**
   * Set or clear a game's review state and tags. Check-in notes and every
   * other game field are untouched.
   * @param {string} userId
   * @param {string} gameId
   * @param {unknown} body
   * @returns {Promise<{review: {state: "todo"|"done"|null, tags: string[], updatedAt: string}|null}|null>}
   */
  async setReview(userId, gameId, body) {
    const id = cleanId(gameId);
    const parsed = normalizeReview(body);
    if ("error" in parsed) throw failure("bad_request", 400, parsed.error);
    if (!id) return null;
    const { state, tags } = parsed.value;
    const now = new Date();
    const clear = state === null && tags.length === 0;
    const saved = await this.db.games.findOneAndUpdate(
      { userId, gameId: id, ...LIVE_GAME },
      clear ? { $unset: { review: "" } } : { $set: { review: { state, tags, updatedAt: now } } },
      { returnDocument: "after", projection: { _id: 0, review: 1 }, includeResultMetadata: false },
    );
    if (!saved) return null;
    return { review: clear ? null : { state, tags, updatedAt: now.toISOString() } };
  }

  /**
   * Distinct review tags this owner has used, for the replay tag filter.
   * @param {string} userId
   * @returns {Promise<string[]>}
   */
  async reviewTags(userId) {
    if (!userId) return [];
    const values = await this.db.games.distinct("review.tags", { userId, "review.tags.0": { $exists: true } }, { maxTimeMS: QUERY_DEADLINE_MS });
    return values.filter((tag) => typeof tag === "string" && tag).sort((a, b) => a.localeCompare(b)).slice(0, 100);
  }
}

module.exports = {
  NotesService,
  NOTES_INDEXES,
  LEGACY_FILTER,
  ensureNotesIndexes,
  serializeNote,
  MIGRATION_BATCH,
  LINKED_NOTES_MAX,
  LIVE_LINKED_NOTES_MAX,
  NOTE_SEARCH_GAMES_MAX,
};
