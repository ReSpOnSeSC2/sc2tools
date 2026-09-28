"use strict";

/**
 * Coach's notes for the SC2 Tools Guides build pages — `guide_notes`,
 * one document per (matchup, build):
 *
 *   { matchup: "PvZ", buildKey: "PvZ - Stargate into Glaives",
 *     body: "<markdown, ≤ GUIDE_NOTE_MAX_CHARS>",
 *     videos: { pinned: [youtubeId ≤ 3], hidden: [youtubeId ≤ 20] },
 *     updatedBy: "<internal admin userId>" | null, updatedAt, _schemaVersion }
 *
 * Unique index {matchup, buildKey} (db/connect.js). Written only through
 * the admin API (routes/adminGuides.js); the public read layer
 * (services/guides.js) exposes ``{ body, updatedAt }`` and uses the video
 * overrides to order the build's videos. ``updatedBy`` is internal audit
 * data: no read here returns it, and GDPR delete scrubs it to null
 * (services/gdpr.js deleteAll) while keeping the note.
 *
 * Saves MERGE: a field present in the request replaces the stored one and
 * an absent field is kept, so the notes editor (body) and the videos
 * panel (overrides) can save independently without clobbering each other.
 */

const { COLLECTIONS } = require("../config/constants");
const { buildSlug } = require("../config/guideSlugs");
const { stampVersion } = require("../db/schemaVersioning");
const { isDuplicateKey } = require("../util/jobLock");
const { validateGuideAdminInput } = require("../validation/guideAdmin");

/** Upper bound on the admin list (one note per catalog build at most). */
const NOTES_LIST_MAX = 1000;
const HTTP_BAD_REQUEST = 400;
/** C0 controls except TAB (\u0009) and LF (\u000a), plus DEL. */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const CRLF_RE = /\r\n?/g;
const READ_PROJECTION = Object.freeze({
  _id: 0, matchup: 1, buildKey: 1, body: 1, videos: 1, updatedAt: 1,
});

/** @typedef {{ pinned: string[], hidden: string[] }} VideoOverrides */

/**
 * @typedef {object} GuideNote internal read shape (never carries updatedBy)
 * @property {string} matchup
 * @property {string} buildKey
 * @property {string} body
 * @property {VideoOverrides} videos
 * @property {Date} updatedAt
 */

/**
 * @typedef {object} AdminGuideNote admin API shape
 * @property {string} matchup
 * @property {string} buildKey
 * @property {string} buildSlug
 * @property {string} body
 * @property {VideoOverrides} videos
 * @property {Date} updatedAt
 */

/**
 * A 400 the routes render as `{ error: { code, message } }`.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & { status: number, code: string }}
 */
function badRequest(code, message) {
  return Object.assign(new Error(message), { status: HTTP_BAD_REQUEST, code });
}

/**
 * Markdown body as stored: CRLF → LF, control characters dropped.
 *
 * Example: `normalizeBody("a\r\nb\u0000")` → "a\nb".
 *
 * @param {string} body
 * @returns {string}
 */
function normalizeBody(body) {
  return body.replace(CRLF_RE, "\n").replace(CONTROL_CHARS_RE, "");
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/**
 * @param {unknown} value stored overrides
 * @returns {VideoOverrides}
 */
function toOverrides(value) {
  const v = value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
  return { pinned: stringList(v.pinned), hidden: stringList(v.hidden) };
}

/**
 * @param {Record<string, any>} doc
 * @returns {GuideNote|null}
 */
function toNote(doc) {
  if (!doc || typeof doc.matchup !== "string" || typeof doc.buildKey !== "string") return null;
  if (!(doc.updatedAt instanceof Date)) return null;
  return {
    matchup: doc.matchup,
    buildKey: doc.buildKey,
    body: typeof doc.body === "string" ? doc.body : "",
    videos: toOverrides(doc.videos),
    updatedAt: doc.updatedAt,
  };
}

/**
 * @param {GuideNote} note
 * @returns {AdminGuideNote|null} null for a note whose build left the catalog
 */
function toAdminNote(note) {
  const slug = buildSlug(note.matchup, note.buildKey);
  if (!slug) return null;
  return { ...note, buildSlug: slug };
}

/**
 * The validated, normalised save input.
 *
 * @param {unknown} input request body
 * @returns {{ body?: string, videos?: VideoOverrides }}
 */
function parseSaveInput(input) {
  const checked = validateGuideAdminInput("note", input);
  if (!checked.valid) throw badRequest("invalid_note", checked.errors.join("; "));
  /** @type {{ body?: string, videos?: VideoOverrides }} */
  const out = {};
  if (typeof checked.value.body === "string") out.body = normalizeBody(checked.value.body);
  if (checked.value.videos) {
    const videos = toOverrides(checked.value.videos);
    if (videos.pinned.some((id) => videos.hidden.includes(id))) {
      throw badRequest("invalid_note", "a video cannot be both pinned and hidden");
    }
    out.videos = videos;
  }
  return out;
}

class GuideNotesService {
  /**
   * @param {{ guideNotes?: import('mongodb').Collection }} db
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.coll = db.guideNotes || null;
    this.now = opts.now || Date.now;
  }

  /**
   * Every note, for the admin page (matchup, then build order).
   *
   * @returns {Promise<AdminGuideNote[]>}
   */
  async list() {
    if (!this.coll) return [];
    const rows = await this.coll
      .find({}, { projection: READ_PROJECTION })
      .sort({ matchup: 1, buildKey: 1 })
      .limit(NOTES_LIST_MAX)
      .toArray();
    /** @type {AdminGuideNote[]} */
    const out = [];
    for (const row of rows) {
      const note = toNote(row);
      const admin = note ? toAdminNote(note) : null;
      if (admin) out.push(admin);
    }
    return out;
  }

  /**
   * One note, or null.
   *
   * Example: `(await guideNotes.find("PvZ", "PvZ - Stargate into Glaives"))?.body`.
   *
   * @param {string} matchup "PvZ" form
   * @param {string} buildKey exact catalog name
   * @returns {Promise<GuideNote|null>}
   */
  async find(matchup, buildKey) {
    if (!this.coll) return null;
    const doc = await this.coll.findOne({ matchup, buildKey }, { projection: READ_PROJECTION });
    return doc ? toNote(doc) : null;
  }

  /**
   * Create or update a note (merge: absent fields are kept). Throws a
   * coded 400 for an invalid body.
   *
   * @param {string} matchup "PvZ" form (already resolved from the URL)
   * @param {string} buildKey exact catalog name
   * @param {unknown} input `{ body?, videos?: { pinned?, hidden? } }`
   * @param {string|null} editorUserId internal userId of the admin
   * @returns {Promise<AdminGuideNote>}
   */
  async save(matchup, buildKey, input, editorUserId) {
    const parsed = parseSaveInput(input);
    if (!this.coll) throw new Error("guide_notes_unavailable");
    try {
      return await this._upsert(matchup, buildKey, parsed, editorUserId);
    } catch (err) {
      // Two first saves raced on the unique {matchup, buildKey}: the
      // loser retries as a plain update of the winner's document.
      if (!isDuplicateKey(err)) throw err;
      return this._upsert(matchup, buildKey, parsed, editorUserId);
    }
  }

  /**
   * @param {string} matchup
   * @param {string} buildKey
   * @param {{ body?: string, videos?: VideoOverrides }} parsed
   * @param {string|null} editorUserId
   * @returns {Promise<AdminGuideNote>}
   */
  async _upsert(matchup, buildKey, parsed, editorUserId) {
    const coll = /** @type {import('mongodb').Collection} */ (this.coll);
    /** @type {Record<string, any>} */
    const onInsert = stampVersion({ matchup, buildKey }, COLLECTIONS.GUIDE_NOTES);
    if (parsed.body === undefined) onInsert.body = "";
    if (parsed.videos === undefined) onInsert.videos = { pinned: [], hidden: [] };
    const doc = await coll.findOneAndUpdate(
      { matchup, buildKey },
      {
        $set: { ...parsed, updatedBy: editorUserId, updatedAt: new Date(this.now()) },
        $setOnInsert: onInsert,
      },
      { upsert: true, returnDocument: "after", projection: READ_PROJECTION },
    );
    const note = doc ? toNote(doc) : null;
    const admin = note ? toAdminNote(note) : null;
    if (!admin) throw new Error("guide_note_write_failed");
    return admin;
  }

  /**
   * Delete a note.
   *
   * @param {string} matchup
   * @param {string} buildKey
   * @returns {Promise<boolean>} true when a note was removed
   */
  async remove(matchup, buildKey) {
    if (!this.coll) return false;
    const res = await this.coll.deleteOne({ matchup, buildKey });
    return res.deletedCount > 0;
  }
}

module.exports = { GuideNotesService, normalizeBody };
