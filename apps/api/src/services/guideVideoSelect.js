"use strict";

/**
 * Guide videos — pure selection over decorated `guide_videos` rows
 * (services/guideVideos.js): which videos a build / counter guide, a
 * matchup page and the hub show, in which order, and the admin row shape.
 *
 * Pure and synchronous: no I/O, no logging.
 */

const { VIDEO_ID_RE } = require("./guideVideoFeed");

/** Videos per build / counter guide (pinned first). */
const GUIDE_VIDEOS_PER_GUIDE = 3;
/** Per-guide override caps (guide_notes.videos). */
const GUIDE_VIDEOS_PINNED_MAX = 3;
const GUIDE_VIDEOS_HIDDEN_MAX = 20;
/** Matchup / hub rows: default and maximum length. */
const VIDEO_LIST_DEFAULT = 4;
const VIDEO_LIST_MAX = 12;

/**
 * @typedef {import('./guideVideoMatch').VideoMatch} VideoMatch
 * @typedef {import('./guideVideoText').PublicVideo} PublicVideo
 */

/**
 * @typedef {object} GuideVideoDoc
 * @property {string} youtubeId
 * @property {string} title
 * @property {string} description
 * @property {Date|null} publishedAt null only for an admin-added video
 *   the channel feed has not dated yet
 * @property {string|null} channelId
 * @property {"rss"|"snapshot"|"admin"} source
 * @property {boolean} isShort
 * @property {boolean} hidden
 * @property {Date} [updatedAt]
 */

/**
 * @typedef {object} VideoRow
 * @property {GuideVideoDoc} doc
 * @property {VideoMatch} match automatic match + curated links
 * @property {boolean} buildOrder a build-order video (matchup detected;
 *   never a Short or a stream VOD)
 * @property {PublicVideo} video
 */

/**
 * @typedef {object} VideoOverrides per-guide overrides from guide_notes
 * @property {string[]} [pinned] youtubeIds shown first (≤ 3)
 * @property {string[]} [hidden] youtubeIds never shown on that guide (≤ 20)
 */

/**
 * @typedef {PublicVideo & {
 *   matchup: string|null, builds: string[], counters: string[],
 *   source: string, hidden: boolean, isShort: boolean,
 * }} AdminVideo
 */

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isVideoId(value) {
  return typeof value === "string" && VIDEO_ID_RE.test(value);
}

/**
 * Unique valid youtubeIds from an override list, in order, at most `max`.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string[]}
 */
function idList(value, max) {
  /** @type {string[]} */
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const id of value) {
    if (out.length >= max) break;
    if (isVideoId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * @param {unknown} n
 * @returns {number} an integer in [1, VIDEO_LIST_MAX] (default 4)
 */
function listCount(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return VIDEO_LIST_DEFAULT;
  return Math.min(VIDEO_LIST_MAX, Math.max(1, Math.floor(n)));
}

/**
 * Newest first; undated (admin-added) rows last; ties by id.
 *
 * @param {VideoRow} a
 * @param {VideoRow} b
 * @returns {number}
 */
function compareRows(a, b) {
  const at = a.doc.publishedAt ? a.doc.publishedAt.getTime() : -Infinity;
  const bt = b.doc.publishedAt ? b.doc.publishedAt.getTime() : -Infinity;
  if (at !== bt) return bt > at ? 1 : -1;
  if (a.doc.youtubeId === b.doc.youtubeId) return 0;
  return a.doc.youtubeId < b.doc.youtubeId ? -1 : 1;
}

/**
 * @param {PublicVideo} video
 * @returns {PublicVideo} a copy callers may mutate
 */
function copyVideo(video) {
  return { ...video, checklist: video.checklist ? [...video.checklist] : null };
}

/**
 * Admin panel row: the public video plus its match and storage flags.
 *
 * @param {VideoRow} row
 * @returns {AdminVideo}
 */
function adminItem(row) {
  return {
    ...copyVideo(row.video),
    matchup: row.match.matchup,
    builds: [...row.match.builds],
    counters: [...row.match.counters],
    source: row.doc.source,
    hidden: row.doc.hidden === true,
    isShort: row.doc.isShort === true,
  };
}

/**
 * Videos for one guide: pinned videos first (in pin order), per-guide
 * hidden removed, then automatic + curated matches newest first; at most
 * GUIDE_VIDEOS_PER_GUIDE. Globally hidden videos never show, pinned or not.
 *
 * Example: pinned ["A"], hidden ["B"], matches [B, C, D] → [A, C, D].
 *
 * @param {ReadonlyArray<VideoRow>} rows sorted newest first
 * @param {(match: VideoMatch) => boolean} matches
 * @param {VideoOverrides|null|undefined} overrides
 * @returns {PublicVideo[]}
 */
function selectForGuide(rows, matches, overrides) {
  const pinned = idList(overrides ? overrides.pinned : undefined, GUIDE_VIDEOS_PINNED_MAX);
  const skip = new Set(idList(overrides ? overrides.hidden : undefined, GUIDE_VIDEOS_HIDDEN_MAX));
  const visible = rows.filter((row) => !row.doc.hidden && !skip.has(row.doc.youtubeId));
  const byId = new Map(visible.map((row) => [row.doc.youtubeId, row]));
  /** @type {VideoRow[]} */
  const picked = [];
  for (const id of pinned) {
    const row = byId.get(id);
    if (row) picked.push(row);
  }
  const pickedIds = new Set(pinned);
  const auto = visible.filter((row) => !pickedIds.has(row.doc.youtubeId) && matches(row.match));
  return [...picked, ...auto].slice(0, GUIDE_VIDEOS_PER_GUIDE).map((row) => copyVideo(row.video));
}

/**
 * Latest visible build-order videos, optionally of one matchup.
 *
 * @param {ReadonlyArray<VideoRow>} rows sorted newest first
 * @param {unknown} n requested length (clamped by listCount)
 * @param {string|null} matchup "PvZ" form, or null for every matchup
 * @returns {PublicVideo[]}
 */
function selectLatest(rows, n, matchup) {
  return rows
    .filter((row) => !row.doc.hidden && row.buildOrder
      && (matchup === null || row.match.matchup === matchup))
    .slice(0, listCount(n))
    .map((row) => copyVideo(row.video));
}

module.exports = {
  GUIDE_VIDEOS_PER_GUIDE,
  GUIDE_VIDEOS_PINNED_MAX,
  GUIDE_VIDEOS_HIDDEN_MAX,
  VIDEO_LIST_DEFAULT,
  VIDEO_LIST_MAX,
  isVideoId,
  idList,
  listCount,
  compareRows,
  adminItem,
  selectForGuide,
  selectLatest,
};
