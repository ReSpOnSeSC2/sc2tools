"use strict";

/**
 * Guide videos — a bounded, dependency-free reader for a YouTube channel's
 * Atom feed (`https://www.youtube.com/feeds/videos.xml?channel_id=<id>`).
 *
 * The feed is small (the 15 newest videos, ~30 KB) and machine-generated,
 * so a scanner over `<entry>` blocks is enough; no XML library is pulled
 * in. Every limit is explicit: input over FEED_MAX_CHARS is refused, at
 * most FEED_MAX_ENTRIES entries are read, and every string is capped.
 * Malformed input never throws: entries missing a valid id, title or
 * published time are dropped, and unreadable input yields [].
 *
 * Pure and synchronous: no I/O, no logging.
 */

/** Largest feed accepted (characters; the network read caps bytes). */
const FEED_MAX_CHARS = 1024 * 1024;
/** Most entries read from one feed. */
const FEED_MAX_ENTRIES = 50;
/** Longest title kept (YouTube caps titles at 100 characters). */
const TITLE_MAX_CHARS = 300;
/** Longest description kept (YouTube caps descriptions at 5000 bytes). */
const DESCRIPTION_MAX_CHARS = 10000;
/** A YouTube video id. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** A YouTube channel id. */
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
/** Largest Unicode code point a numeric character reference may name. */
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;

/** @type {Readonly<Record<string, string>>} */
const NAMED_ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" });
const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]{2,4});/g;
const CDATA_RE = /^<!\[CDATA\[([\s\S]*)\]\]>$/;
const ENTRY_OPEN = "<entry";
const ENTRY_CLOSE = "</entry>";
const LINK_OPEN = "<link";
const TAG_END = ">";
const ATTR_REL_RE = /\brel\s*=\s*"([^"]*)"/;
const ATTR_HREF_RE = /\bhref\s*=\s*"([^"]*)"/;
/** What may follow a tag name in an opening tag: its end or attributes. */
const TAG_NAME_END_RE = /[\s>]/;
const SHORTS_PATH = "/shorts/";

/**
 * @typedef {object} FeedVideo
 * @property {string} youtubeId
 * @property {string} title
 * @property {string} description
 * @property {string} publishedAt ISO time
 * @property {string|null} channelId "UC…" id, or null when absent/invalid
 * @property {boolean} isShort    true when YouTube links it under /shorts/
 */

const TAGS = Object.freeze({
  videoId: "yt:videoId",
  channelId: "yt:channelId",
  title: "title",
  published: "published",
  description: "media:description",
});

/**
 * @param {number} code
 * @returns {boolean}
 */
function isValidCodePoint(code) {
  return Number.isInteger(code) && code > 0 && code <= MAX_CODE_POINT
    && (code < SURROGATE_MIN || code > SURROGATE_MAX);
}

/**
 * Decode the five XML entities and numeric character references.
 * Unknown or invalid references are left as written.
 *
 * Example: `decodeXmlEntities("Q&amp;A &#8212; &quot;hi&quot;")` → `Q&A — "hi"`.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeXmlEntities(text) {
  return text.replace(ENTITY_RE, (whole, ref) => {
    if (ref[0] !== "#") return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : whole;
    const hex = ref[1] === "x" || ref[1] === "X";
    const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? HEX_RADIX : DECIMAL_RADIX);
    return isValidCodePoint(code) ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Raw content of the first `<tag …>…</tag>` element in `block`, or null.
 * indexOf scanning, not a regex: a lazy `[\s\S]*?` pattern re-scans to
 * the end of the block from every unclosed opening tag, which turns a
 * hostile 1 MB feed into minutes of blocked event loop. This is linear.
 *
 * @param {string} block
 * @param {string} tag element name ("title", "yt:videoId")
 * @returns {string|null}
 */
function rawElement(block, tag) {
  const open = `<${tag}`;
  let from = 0;
  for (;;) {
    const start = block.indexOf(open, from);
    if (start < 0) return null;
    from = start + open.length;
    // "<title" must not match "<titles>"; attributes are allowed.
    if (!TAG_NAME_END_RE.test(block.charAt(from))) continue;
    const contentStart = block.indexOf(TAG_END, from);
    if (contentStart < 0) return null;
    const end = block.indexOf(`</${tag}>`, contentStart);
    return end < 0 ? null : block.slice(contentStart + 1, end);
  }
}

/**
 * Text content of the first `tag` element in `block` (CDATA or entities
 * decoded), or null.
 *
 * @param {string} block
 * @param {string} tag element name
 * @returns {string|null}
 */
function elementText(block, tag) {
  const raw = rawElement(block, tag);
  if (raw === null) return null;
  const cdata = CDATA_RE.exec(raw.trim());
  return cdata ? cdata[1] : decodeXmlEntities(raw);
}

/**
 * href of the entry's `<link rel="alternate">` (linear scan, see
 * rawElement).
 *
 * @param {string} block
 * @returns {string}
 */
function alternateHref(block) {
  let from = 0;
  for (;;) {
    const start = block.indexOf(LINK_OPEN, from);
    if (start < 0) return "";
    const end = block.indexOf(TAG_END, start);
    if (end < 0) return "";
    const tag = block.slice(start, end + 1);
    const rel = ATTR_REL_RE.exec(tag);
    const href = ATTR_HREF_RE.exec(tag);
    if (rel && rel[1] === "alternate" && href) return decodeXmlEntities(href[1]);
    from = end + 1;
  }
}

/**
 * @param {string|null} raw
 * @returns {string|null} ISO time, or null when unparsable
 */
function isoTime(raw) {
  if (!raw) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * One `<entry>` block → a FeedVideo, or null when it lacks a valid id,
 * title or published time.
 *
 * @param {string} block
 * @returns {FeedVideo|null}
 */
function parseEntry(block) {
  const youtubeId = (elementText(block, TAGS.videoId) || "").trim();
  const title = (elementText(block, TAGS.title) || "").trim();
  const publishedAt = isoTime(elementText(block, TAGS.published));
  if (!VIDEO_ID_RE.test(youtubeId) || !title || title.length > TITLE_MAX_CHARS || !publishedAt) {
    return null;
  }
  const channelId = (elementText(block, TAGS.channelId) || "").trim();
  return {
    youtubeId,
    title,
    description: (elementText(block, TAGS.description) || "").slice(0, DESCRIPTION_MAX_CHARS),
    publishedAt,
    channelId: CHANNEL_ID_RE.test(channelId) ? channelId : null,
    isShort: alternateHref(block).includes(SHORTS_PATH),
  };
}

/**
 * The raw `<entry>…</entry>` blocks of a feed, at most FEED_MAX_ENTRIES.
 *
 * @param {string} xml
 * @returns {string[]}
 */
function entryBlocks(xml) {
  /** @type {string[]} */
  const blocks = [];
  let from = 0;
  while (blocks.length < FEED_MAX_ENTRIES) {
    const open = xml.indexOf(ENTRY_OPEN, from);
    if (open < 0) break;
    const close = xml.indexOf(ENTRY_CLOSE, open);
    if (close < 0) break;
    blocks.push(xml.slice(open, close));
    from = close + ENTRY_CLOSE.length;
  }
  return blocks;
}

/**
 * Parse a YouTube channel Atom feed into videos (feed order, duplicate ids
 * dropped). Bounded and total: never throws.
 *
 * Example: `parseChannelFeed(xml)[0]` →
 * `{ youtubeId: "JjFO05IA6ZY", title: "GM Protoss …", publishedAt: "2026-09-27T14:37:27.000Z", … }`.
 *
 * @param {unknown} xml
 * @returns {FeedVideo[]} [] for non-strings, oversize or unreadable input
 */
function parseChannelFeed(xml) {
  if (typeof xml !== "string" || xml.length > FEED_MAX_CHARS) return [];
  try {
    /** @type {FeedVideo[]} */
    const videos = [];
    const seen = new Set();
    for (const block of entryBlocks(xml)) {
      const video = parseEntry(block);
      if (!video || seen.has(video.youtubeId)) continue;
      seen.add(video.youtubeId);
      videos.push(video);
    }
    return videos;
  } catch {
    return [];
  }
}

module.exports = {
  FEED_MAX_CHARS,
  FEED_MAX_ENTRIES,
  VIDEO_ID_RE,
  CHANNEL_ID_RE,
  decodeXmlEntities,
  parseChannelFeed,
};
