"use strict";

/**
 * Guide videos — the author's own words, lifted verbatim from a video
 * description (services/guideVideos.js), plus the public Video shape.
 *
 *   - extractExcerpt: the description's first paragraph, cut at a word
 *     boundary so it fits EXCERPT_MAX_CHARS.
 *   - extractChecklist: the lines of the first ALL-CAPS section whose
 *     header names a BUILD, OPENER, RESPONSE or NOTES (e.g. "BUILD
 *     CHECKLIST", "▬▬ THE 8-POOL RESPONSE ▬▬", "QUICK BUILD NOTES").
 *     Headers about sources rather than the build ("BUILD INSPIRATION",
 *     "EVIDENCE NOTES", credits, music, chapters) are skipped. Lines are
 *     never rewritten beyond trimming, collapsing whitespace and stripping
 *     "•" bullets: a section with a line longer than
 *     CHECKLIST_LINE_MAX_CHARS is prose, not a checklist, and is skipped
 *     rather than truncated.
 *
 * Pure and synchronous: no I/O, no logging.
 */

/** Longest excerpt (characters, ellipsis included). */
const EXCERPT_MAX_CHARS = 300;
/** Checklist cap: at most this many lines per checklist. */
const CHECKLIST_MAX_LINES = 20;
/** Checklist lines longer than this mark the section as prose. */
const CHECKLIST_LINE_MAX_CHARS = 160;
/** Section headers longer than this are sentences, not headers. */
const HEADER_MAX_CHARS = 60;
/** Longest description read (YouTube caps descriptions at 5000 bytes). */
const MAX_DESCRIPTION_CHARS = 10000;
/** Header decoration stripped before the ALL-CAPS test ("▬▬▬ BUILD ▬▬▬"). */
const HEADER_DECORATION_RE = /▬+/g;
/** Header words that introduce the author's build steps. */
const CHECKLIST_HEADER_RE = /\b(?:BUILD|OPENER|RESPONSE|NOTES)\b/;
/** Header words that introduce sources, credits or navigation instead. */
const CHECKLIST_HEADER_SKIP_RE = /\b(?:INSPIRATION|EVIDENCE|CREDITS?|SOURCES?|MUSIC|CHAPTERS)\b/;
/** Leading bullet(s) on a checklist line. */
const BULLET_RE = /^•+\s*/;
const ELLIPSIS = "…";

const WATCH_URL = "https://www.youtube.com/watch?v=";
const THUMBNAIL_URL = "https://i.ytimg.com/vi/";
const THUMBNAIL_FILE = "/hqdefault.jpg";
const EMBED_URL = "https://www.youtube-nocookie.com/embed/";

/**
 * @typedef {object} PublicVideo
 * @property {string} youtubeId
 * @property {string} title
 * @property {string|null} publishedAt ISO time; null only for an
 *   admin-added video the channel feed has not dated yet
 * @property {string} url           watch page
 * @property {string} thumbnailUrl  hqdefault thumbnail
 * @property {string} embedUrl      youtube-nocookie embed (no query)
 * @property {string} excerpt       first paragraph ("" when none)
 * @property {string[]|null} checklist the author's build steps, verbatim
 * @property {boolean} [eightWorkerPatch] published during the 8-worker
 *   patch 5.0.16 (set by services/guideVideos.js, which knows the window)
 */

/**
 * @typedef {object} StoredVideoText
 * @property {string} youtubeId
 * @property {string} title
 * @property {string} [description]
 * @property {Date|string|null} [publishedAt]
 */

/**
 * Description as display lines: CRLF → LF, non-breaking spaces → spaces.
 *
 * @param {unknown} description
 * @returns {string}
 */
function cleanDescription(description) {
  if (typeof description !== "string") return "";
  return description
    .slice(0, MAX_DESCRIPTION_CHARS)
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ");
}

/**
 * @param {string} text
 * @returns {string} trimmed, whitespace runs collapsed to one space
 */
function collapseSpaces(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The description's first paragraph, at most EXCERPT_MAX_CHARS long,
 * cut at a word boundary (with "…") when longer.
 *
 * Example: `extractExcerpt("Build a plan.\n\nMore")` → "Build a plan.".
 *
 * @param {unknown} description
 * @returns {string} "" when the description is empty
 */
function extractExcerpt(description) {
  const paragraph = cleanDescription(description)
    .split(/\n\s*\n/)
    .map(collapseSpaces)
    .find(Boolean) || "";
  if (paragraph.length <= EXCERPT_MAX_CHARS) return paragraph;
  const room = paragraph.slice(0, EXCERPT_MAX_CHARS - ELLIPSIS.length + 1);
  const cut = room.lastIndexOf(" ");
  const head = cut > 0 ? room.slice(0, cut) : room.slice(0, -1);
  return `${head.replace(/[\s,;:.–—-]+$/, "")}${ELLIPSIS}`;
}

/**
 * Header text of a line when it is an ALL-CAPS section header.
 *
 * @param {string} line trimmed line
 * @returns {string|null}
 */
function allCapsHeader(line) {
  if (BULLET_RE.test(line)) return null;
  const header = collapseSpaces(line.replace(HEADER_DECORATION_RE, " "));
  if (!header || header.length > HEADER_MAX_CHARS) return null;
  return /[A-Z]/.test(header) && !/[a-z]/.test(header) ? header : null;
}

/**
 * @param {string|null} header
 * @returns {boolean}
 */
function isChecklistHeader(header) {
  return header !== null
    && CHECKLIST_HEADER_RE.test(header)
    && !CHECKLIST_HEADER_SKIP_RE.test(header);
}

/**
 * The checklist lines after a header: leading blank lines skipped, then
 * lines up to the next blank line / ALL-CAPS header / CHECKLIST_MAX_LINES.
 *
 * @param {string[]} lines
 * @param {number} start index after the header
 * @returns {string[]|null} null when empty or when a line is prose-length
 */
function sectionLines(lines, start) {
  /** @type {string[]} */
  const items = [];
  for (let i = start; i < lines.length && items.length < CHECKLIST_MAX_LINES; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      if (items.length > 0) break;
      continue;
    }
    if (allCapsHeader(line) !== null) break;
    const item = collapseSpaces(line.replace(BULLET_RE, ""));
    if (item.length > CHECKLIST_LINE_MAX_CHARS) return null;
    if (item) items.push(item);
  }
  return items.length > 0 ? items : null;
}

/**
 * The author's build checklist from a video description (see the module
 * comment for the section rule).
 *
 * Example: "BUILD CHECKLIST\n• 14 Gateway\n• Stargate at 150 gas\n\nCHAPTERS…"
 * → ["14 Gateway", "Stargate at 150 gas"].
 *
 * @param {unknown} description
 * @returns {string[]|null} null when no section qualifies
 */
function extractChecklist(description) {
  const lines = cleanDescription(description).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!isChecklistHeader(allCapsHeader(lines[i].trim()))) continue;
    const items = sectionLines(lines, i + 1);
    if (items) return items;
  }
  return null;
}

/**
 * @param {Date|string|null|undefined} value
 * @returns {string|null} ISO time, or null when missing/invalid
 */
function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The public Video shape served by every guide payload.
 *
 * Example: `toPublicVideo({ youtubeId: "YcTMc_Ee11w", title: "…" }).embedUrl`
 * → "https://www.youtube-nocookie.com/embed/YcTMc_Ee11w".
 *
 * @param {StoredVideoText} doc
 * @returns {PublicVideo}
 */
function toPublicVideo(doc) {
  const id = doc.youtubeId;
  return {
    youtubeId: id,
    title: doc.title,
    publishedAt: isoOrNull(doc.publishedAt),
    url: `${WATCH_URL}${id}`,
    thumbnailUrl: `${THUMBNAIL_URL}${id}${THUMBNAIL_FILE}`,
    embedUrl: `${EMBED_URL}${id}`,
    excerpt: extractExcerpt(doc.description),
    checklist: extractChecklist(doc.description),
  };
}

module.exports = {
  EXCERPT_MAX_CHARS,
  CHECKLIST_MAX_LINES,
  CHECKLIST_LINE_MAX_CHARS,
  WATCH_URL,
  extractExcerpt,
  extractChecklist,
  toPublicVideo,
};
