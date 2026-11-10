"use strict";

/**
 * Pure rules for the unified notes system. No I/O: the service, the routes
 * and the privacy filters share these so one definition decides what a note
 * may contain and where it may be shown.
 *
 *   - ``visibility: "stream"`` notes may reach the OBS overlay; ``private``
 *     notes never do. A note carrying a private tag (Toxic) is private
 *     whatever its stored visibility says.
 *   - ``scope: "account"`` notes describe one exact account; ``player``
 *     notes follow that player's linked accounts (exact toon first, then
 *     the group key / Pulse account).
 *   - Game notes are always private and account scoped.
 */

const { LIMITS } = require("../config/constants");
const { cleanText, containsBlockedTerm } = require("../util/contentFilter");
const {
  CHEESE_ALERT_THRESHOLD,
  cheeseProbability,
  personalOppStrategy,
} = require("./scouting/opponentTendencies");

/** Preset tags offered in every tag picker, in display order. */
const PRESET_TAGS = Object.freeze(["Cheeser", "Proxy", "All-in", "Macro", "Smurf", "Off-race", "Rival", "Toxic"]);
/** Tags that make a note private wherever it is shown. */
const PRIVATE_TAGS = Object.freeze(["Toxic"]);
const VISIBILITIES = Object.freeze(["stream", "private"]);
const SCOPES = Object.freeze(["account", "player"]);
const REVIEW_STATES = Object.freeze(["todo", "done"]);
/** Suggest "Cheeser" from this many labelled games upward. */
const CHEESER_MIN_GAMES = 3;
/** Map coordinates are world cells; every ladder map fits well inside. */
const MAP_COORD_MAX = 1024;
const GAME_TIME_MAX_SEC = 24 * 60 * 60;

const PRESET_BY_KEY = new Map(PRESET_TAGS.map((tag) => [tag.toLowerCase(), tag]));
const PRIVATE_KEYS = new Set(PRIVATE_TAGS.map((tag) => tag.toLowerCase()));

/**
 * @typedef {{
 *   text?: string,
 *   tags?: string[],
 *   visibility?: string,
 *   readAloud?: boolean,
 * }} NoteLike
 */

/**
 * One tag in its stored spelling: cleaned, single-line, at most
 * ``NOTE_TAG_MAX_LENGTH`` characters. A preset matched case-insensitively
 * takes the preset's spelling so filters and the overlay rule agree.
 *
 * @param {unknown} raw
 * @returns {string|null} null when empty or not a string
 */
function canonicalTag(raw) {
  if (typeof raw !== "string") return null;
  const tag = cleanText(raw).replace(/^#+/, "").trim();
  if (!tag) return null;
  return PRESET_BY_KEY.get(tag.toLowerCase()) || tag;
}

/**
 * Validate and canonicalise a tag list. Duplicates (case-insensitive)
 * collapse to the first spelling.
 *
 * Example: normalizeTags(["proxy", " Proxy ", "early"], 8)
 *   → { tags: ["Proxy", "early"] }
 *
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {{tags: string[], error?: undefined} | {tags?: undefined, error: string}}
 */
function normalizeTags(raw, max = LIMITS.NOTE_TAGS_MAX) {
  if (raw === undefined || raw === null) return { tags: [] };
  if (!Array.isArray(raw)) return { error: "tags must be an array of strings" };
  if (raw.length > max * 2) return { error: `tags may contain at most ${max} entries` };
  /** @type {string[]} */
  const tags = [];
  const seen = new Set();
  for (const value of raw) {
    if (typeof value !== "string") return { error: "tags must be an array of strings" };
    const tag = canonicalTag(value);
    if (!tag) continue;
    if (Array.from(tag).length > LIMITS.NOTE_TAG_MAX_LENGTH) {
      return { error: `each tag must contain at most ${LIMITS.NOTE_TAG_MAX_LENGTH} characters` };
    }
    if (containsBlockedTerm(tag)) return { error: "a tag contains a blocked term" };
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > max) return { error: `tags may contain at most ${max} entries` };
  return { tags };
}

/** @param {unknown} tag */
function isPrivateTag(tag) {
  return typeof tag === "string" && PRIVATE_KEYS.has(tag.toLowerCase());
}

/** @param {unknown} tags */
function hasPrivateTag(tags) {
  return Array.isArray(tags) && tags.some(isPrivateTag);
}

/**
 * Note body as stored: control characters removed, lines trimmed, at most
 * two consecutive blank lines. Null when the input is not a string.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeNoteText(raw) {
  if (typeof raw !== "string") return null;
  return cleanText(raw, { multiline: true });
}

/**
 * Whether a stored note may appear on the OBS overlay (and its voice).
 * The single rule every overlay path uses.
 *
 * @param {NoteLike|null|undefined} note
 * @returns {boolean}
 */
function streamEligible(note) {
  return Boolean(note)
    && note?.visibility === "stream"
    && !hasPrivateTag(note?.tags)
    && typeof note?.text === "string"
    && note.text.trim().length > 0;
}

/**
 * Apply the stored-shape invariants to an opponent note about to be saved:
 * a private tag forces private visibility, and only a stream note may be
 * read aloud.
 *
 * @template {{visibility: string, tags: string[], readAloud: boolean}} T
 * @param {T} note
 * @returns {T}
 */
function enforceNoteInvariants(note) {
  const visibility = hasPrivateTag(note.tags) ? "private" : note.visibility;
  return { ...note, visibility, readAloud: visibility === "stream" && note.readAloud === true };
}

/**
 * Deterministic tag suggestions for one opponent, never applied
 * automatically. "Cheeser" when at least 40% of their labelled openings are
 * early all-ins and there are at least three such games.
 *
 * Example: suggestTags([{opponent:{strategy:"Zerg - 12 Pool"}}, ...3 games])
 *   → ["Cheeser"]
 *
 * @param {Array<Record<string, any>>} games the opponent's games, any order
 * @param {string[]} [existing] tags already on the note (never re-suggested)
 * @returns {string[]}
 */
function suggestTags(games, existing = []) {
  const have = new Set((existing || []).map((tag) => String(tag).toLowerCase()));
  /** @type {string[]} */
  const out = [];
  let labelled = 0;
  let cheese = 0;
  for (const game of Array.isArray(games) ? games : []) {
    const label = personalOppStrategy(game);
    if (!label) continue;
    labelled += 1;
    if (cheeseProbability(label) >= CHEESE_ALERT_THRESHOLD) cheese += 1;
  }
  if (labelled >= CHEESER_MIN_GAMES && cheese / labelled >= CHEESE_ALERT_THRESHOLD && !have.has("cheeser")) {
    out.push("Cheeser");
  }
  return out;
}

/**
 * Validate a game note's moment and optional map point.
 *
 * @param {Record<string, unknown>} body
 * @param {{partial?: boolean}} [opts] partial updates may omit both
 * @returns {{value: {gameTimeSec?: number|null, x?: number|null, y?: number|null}}|{error: string}}
 */
function normalizeGamePoint(body, opts = {}) {
  /** @type {{gameTimeSec?: number|null, x?: number|null, y?: number|null}} */
  const value = {};
  if (Object.hasOwn(body, "gameTimeSec")) {
    const t = body.gameTimeSec;
    if (t === null) value.gameTimeSec = null;
    else if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > GAME_TIME_MAX_SEC) {
      return { error: `gameTimeSec must be a number from 0 to ${GAME_TIME_MAX_SEC}` };
    } else value.gameTimeSec = Math.round(t * 10) / 10;
  } else if (!opts.partial) value.gameTimeSec = null;
  const hasX = Object.hasOwn(body, "x");
  const hasY = Object.hasOwn(body, "y");
  if (hasX !== hasY) return { error: "x and y must be sent together" };
  if (hasX) {
    if (body.x === null && body.y === null) { value.x = null; value.y = null; }
    else {
      for (const key of /** @type {const} */ (["x", "y"])) {
        const n = body[key];
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAP_COORD_MAX) {
          return { error: `${key} must be a number from 0 to ${MAP_COORD_MAX}` };
        }
      }
      value.x = Math.round(/** @type {number} */ (body.x) * 10) / 10;
      value.y = Math.round(/** @type {number} */ (body.y) * 10) / 10;
    }
  } else if (!opts.partial) { value.x = null; value.y = null; }
  return { value };
}

/**
 * Validate a review subdocument update. ``state: null`` with no tags clears
 * the review entirely.
 *
 * @param {unknown} raw
 * @returns {{value: {state: "todo"|"done"|null, tags: string[]}}|{error: string}}
 */
function normalizeReview(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be an object" };
  const body = /** @type {Record<string, unknown>} */ (raw);
  const extra = Object.keys(body).filter((key) => key !== "state" && key !== "tags");
  if (extra.length) return { error: `unknown field: ${extra[0]}` };
  const state = body.state === undefined ? null : body.state;
  if (state !== null && !REVIEW_STATES.includes(/** @type {string} */ (state))) {
    return { error: "state must be todo, done or null" };
  }
  const tags = normalizeTags(body.tags, LIMITS.REVIEW_TAGS_MAX);
  if (tags.error !== undefined) return { error: tags.error };
  return { value: { state: /** @type {"todo"|"done"|null} */ (state), tags: tags.tags || [] } };
}

module.exports = {
  PRESET_TAGS,
  PRIVATE_TAGS,
  VISIBILITIES,
  SCOPES,
  REVIEW_STATES,
  CHEESER_MIN_GAMES,
  MAP_COORD_MAX,
  canonicalTag,
  normalizeTags,
  isPrivateTag,
  hasPrivateTag,
  normalizeNoteText,
  streamEligible,
  enforceNoteInvariants,
  suggestTags,
  normalizeGamePoint,
  normalizeReview,
};
