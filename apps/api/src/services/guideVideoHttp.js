"use strict";

/**
 * Guide videos — the two YouTube requests the video sync makes, both
 * bounded (timeout + byte cap) and both failing with coded errors that
 * carry no URL or provider body:
 *
 *   - fetchChannelFeed: the channel's public Atom feed (10 s, 1 MB).
 *   - lookupOembed: a video's title and author via oEmbed (5 s, 64 KB),
 *     used when an admin adds an older video by id.
 *
 * The error codes double as log reason codes (services/guideVideos.js,
 * jobs/guideVideosSyncJob.js) and as API error codes (the admin routes):
 * `<prefix>_timeout`, `<prefix>_unreachable`, `<prefix>_http_<status>`,
 * `<prefix>_too_large`, `<prefix>_unreadable`, `video_lookup_failed`.
 */

const { readTextBounded } = require("./gameVods");
const { CHANNEL_ID_RE } = require("./guideVideoFeed");
const { WATCH_URL } = require("./guideVideoText");

const FEED_URL = "https://www.youtube.com/feeds/videos.xml";
const OEMBED_URL = "https://www.youtube.com/oembed";
const FEED_TIMEOUT_MS = 10_000;
const FEED_MAX_BYTES = 1024 * 1024;
const OEMBED_TIMEOUT_MS = 5_000;
const OEMBED_MAX_BYTES = 64 * 1024;
const REQUEST_HEADERS = Object.freeze({
  "User-Agent": "SC2Tools guide videos (+https://sc2tools.com)",
  "Accept-Language": "en-US,en;q=0.9",
});
/** Message readTextBounded (services/gameVods.js) throws over the cap. */
const TOO_LARGE_MESSAGE = "provider page too large";
const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
const CANONICAL_YOUTUBE_ORIGIN = "https://www.youtube.com";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;

/** @typedef {Error & { code: string, status: number }} GuideVideoError */

/**
 * An Error the API error handler renders as `{ error: { code } }` with
 * HTTP `status`.
 *
 * @param {string} code
 * @param {number} status
 * @returns {GuideVideoError}
 */
function videoError(code, status) {
  const err = /** @type {GuideVideoError} */ (new Error(code));
  err.code = code;
  err.status = status;
  return err;
}

/**
 * @param {unknown} value
 * @returns {string|null} the value when it is a "UC…" channel id
 */
function validChannelId(value) {
  return typeof value === "string" && CHANNEL_ID_RE.test(value) ? value : null;
}

/**
 * A YouTube channel URL in canonical form
 * (`https://www.youtube.com/<path>`, no trailing slash, no query), or null.
 *
 * Example: `validChannelUrl("https://youtube.com/@ReSpOnSeSC2/")` →
 * "https://www.youtube.com/@ReSpOnSeSC2".
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function validChannelUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    if (url.protocol !== "https:" || !YOUTUBE_HOSTS.has(url.hostname) || !path) return null;
    return `${CANONICAL_YOUTUBE_ORIGIN}${path}`;
  } catch {
    return null;
  }
}

/**
 * A string field of a thrown value ("" when absent).
 *
 * @param {unknown} err
 * @param {"name"|"message"} field
 * @returns {string}
 */
function errorField(err, field) {
  if (!err || typeof err !== "object") return "";
  const value = /** @type {Record<string, unknown>} */ (err)[field];
  return typeof value === "string" ? value : "";
}

/**
 * True when a fetch or body read was cut by the request's timeout signal.
 * AbortSignal.timeout rejects with a DOMException, which is not an Error
 * instance in every realm: read the name structurally.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTimeout(err) {
  const name = errorField(err, "name");
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Reason suffix for a failed body read. The timeout signal also covers
 * the body stream, so a slow body is a timeout, not an unreadable one.
 *
 * @param {unknown} err
 * @returns {"too_large"|"timeout"|"unreadable"}
 */
function bodyFailure(err) {
  if (errorField(err, "message") === TOO_LARGE_MESSAGE) return "too_large";
  return isTimeout(err) ? "timeout" : "unreadable";
}

/**
 * GET a URL with a timeout (connect + body) and a byte cap.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{ timeoutMs: number, maxBytes: number, prefix: string, status: number }} opts
 * @returns {Promise<string>}
 */
async function fetchBounded(fetchImpl, url, { timeoutMs, maxBytes, prefix, status }) {
  let res;
  try {
    res = await fetchImpl(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw videoError(`${prefix}_${isTimeout(err) ? "timeout" : "unreachable"}`, status);
  }
  if (!res || !res.ok) throw videoError(`${prefix}_http_${res ? res.status : 0}`, status);
  try {
    return await readTextBounded(res, maxBytes);
  } catch (err) {
    throw videoError(`${prefix}_${bodyFailure(err)}`, status);
  }
}

/**
 * The channel's Atom feed as text.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} channelId "UC…" id
 * @returns {Promise<string>}
 */
function fetchChannelFeed(fetchImpl, channelId) {
  const url = `${FEED_URL}?channel_id=${encodeURIComponent(channelId)}`;
  return fetchBounded(fetchImpl, url, {
    timeoutMs: FEED_TIMEOUT_MS, maxBytes: FEED_MAX_BYTES, prefix: "feed", status: HTTP_BAD_GATEWAY,
  });
}

/**
 * @param {string} text
 * @returns {any} parsed JSON, or null
 */
function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Title and author channel URL of a public video via YouTube oEmbed.
 * Fails with a 422 coded error when the lookup or its body is unusable.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} youtubeId
 * @returns {Promise<{ title: string, authorUrl: string }>}
 */
async function lookupOembed(fetchImpl, youtubeId) {
  const target = encodeURIComponent(`${WATCH_URL}${youtubeId}`);
  const text = await fetchBounded(fetchImpl, `${OEMBED_URL}?url=${target}&format=json`, {
    timeoutMs: OEMBED_TIMEOUT_MS, maxBytes: OEMBED_MAX_BYTES, prefix: "video_lookup", status: HTTP_UNPROCESSABLE,
  });
  const body = parseJsonOrNull(text);
  const title = body && typeof body.title === "string" ? body.title.trim() : "";
  if (!title) throw videoError("video_lookup_failed", HTTP_UNPROCESSABLE);
  return { title, authorUrl: typeof body.author_url === "string" ? body.author_url : "" };
}

module.exports = {
  FEED_URL,
  OEMBED_URL,
  FEED_TIMEOUT_MS,
  FEED_MAX_BYTES,
  OEMBED_TIMEOUT_MS,
  HTTP_BAD_REQUEST,
  HTTP_UNPROCESSABLE,
  HTTP_BAD_GATEWAY,
  HTTP_UNAVAILABLE,
  videoError,
  validChannelId,
  validChannelUrl,
  fetchChannelFeed,
  lookupOembed,
};
