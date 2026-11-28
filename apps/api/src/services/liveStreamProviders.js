"use strict";

/**
 * Provider calls behind the public Live Streams list: every StarCraft II
 * broadcast that is live now on Twitch (`helix/streams`) and Kick
 * (`public/v2/livestreams`), read with the server's own app tokens so a
 * visitor's browser never reaches a provider. Each fetcher returns streams
 * in one normalized shape; the cache and failure handling live in
 * `liveStreams.js`.
 */

const { PlatformOauthError, postForm, fetchJson } = require("./platformOauthHttp");
const { TWITCH_STARCRAFT_GAME_ID, kickCategorySearchUrl, pickKickCategoryId } = require("./sc2Categories");

const PAGE_SIZE = 100;
/** A full page of 100 is three times the usual number of live channels. */
const MAX_PAGES = 3;
const TWITCH_STREAMS_URL = "https://api.twitch.tv/helix/streams";
const KICK_API = "https://api.kick.com/public/v2";

/**
 * One live broadcast, identical for every platform.
 *
 * @typedef {{
 *   id: string,
 *   platform: "twitch" | "kick",
 *   channel: string,
 *   title: string,
 *   language: string,
 *   viewers: number,
 *   startedAt: string,
 *   url: string,
 * }} LiveStream
 */
/** @typedef {{ clientId: string, clientSecret: string, redirectUri: string }} ProviderCredentials */

/**
 * Lower-case primary language subtag ("en-US" becomes "en"); "other" when the
 * provider sends nothing usable (Twitch uses "other" itself).
 *
 * @param {unknown} value
 */
function normalizeLanguage(value) {
  const primary = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : "other";
}

/** @param {unknown} value */
function viewerCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** @param {unknown} value @param {number} max */
function cleanText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * @param {{
 *   id?: unknown, user_login?: unknown, user_name?: unknown, title?: unknown,
 *   language?: unknown, viewer_count?: unknown, started_at?: unknown,
 * }} row
 * @returns {LiveStream | null}
 */
function normalizeTwitchStream(row) {
  const login = cleanText(row?.user_login, 40).toLowerCase();
  if (!row?.id || !/^[a-z0-9_]{1,40}$/.test(login)) return null;
  return {
    id: `twitch:${row.id}`,
    platform: "twitch",
    channel: cleanText(row.user_name, 60) || login,
    title: cleanText(row.title, 140),
    language: normalizeLanguage(row.language),
    viewers: viewerCount(row.viewer_count),
    startedAt: cleanText(row.started_at, 40),
    url: `https://www.twitch.tv/${login}`,
  };
}

/**
 * @param {{
 *   id?: unknown, broadcaster_user?: { username?: unknown }, channel?: { slug?: unknown },
 *   title?: unknown, language_code?: unknown, viewer_count?: unknown, started_at?: unknown,
 * }} row
 * @returns {LiveStream | null}
 */
function normalizeKickStream(row) {
  const slug = cleanText(row?.channel?.slug, 60);
  if (!row?.id || !/^[A-Za-z0-9_-]{1,60}$/.test(slug)) return null;
  return {
    id: `kick:${row.id}`,
    platform: "kick",
    channel: cleanText(row.broadcaster_user?.username, 60) || slug,
    title: cleanText(row.title, 140),
    language: normalizeLanguage(row.language_code),
    viewers: viewerCount(row.viewer_count),
    startedAt: cleanText(row.started_at, 40),
    url: `https://kick.com/${slug}`,
  };
}

/** @param {Array<LiveStream | null>} streams @returns {LiveStream[]} */
function compact(streams) {
  return streams.filter(/** @returns {s is LiveStream} */ s => s !== null);
}

/**
 * Twitch documents that paging can return one stream twice while viewer counts
 * move; the first copy (the earlier page) is kept.
 *
 * @param {LiveStream[]} streams
 * @returns {LiveStream[]}
 */
function uniqueById(streams) {
  const seen = new Set();
  return streams.filter(stream => !seen.has(stream.id) && seen.add(stream.id));
}

/**
 * Twitch lists a game's live streams by viewers, highest first.
 *
 * @param {{ credentials: ProviderCredentials, token: string, fetchImpl: typeof fetch }} input
 * @returns {Promise<LiveStream[]>}
 */
async function fetchTwitchStreams({ credentials, token, fetchImpl }) {
  /** @type {LiveStream[]} */
  const streams = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      game_id: TWITCH_STARCRAFT_GAME_ID,
      type: "live",
      first: String(PAGE_SIZE),
    });
    if (cursor) query.set("after", cursor);
    const json = await fetchJson(
      fetchImpl,
      `${TWITCH_STREAMS_URL}?${query}`,
      { headers: { "Client-Id": credentials.clientId, Authorization: `Bearer ${token}` } },
      "twitch_live_streams",
    );
    streams.push(...compact((Array.isArray(json.data) ? json.data : []).map(normalizeTwitchStream)));
    cursor = String(json.pagination?.cursor || "");
    if (!cursor) break;
  }
  return uniqueById(streams);
}

/**
 * Kick's v2 category search, by exact name. Throws when Kick has no such
 * category so the failure is visible instead of an empty list.
 *
 * @param {{ token: string, fetchImpl: typeof fetch }} input
 * @returns {Promise<number>}
 */
async function findKickCategoryId({ token, fetchImpl }) {
  const json = await fetchJson(
    fetchImpl,
    kickCategorySearchUrl(),
    { headers: { Authorization: `Bearer ${token}` } },
    "kick_category_search",
  );
  const id = pickKickCategoryId(json.data);
  if (id === null) {
    throw new PlatformOauthError("kick_category_missing", "Kick has no StarCraft II category");
  }
  return id;
}

/**
 * Kick lists oldest first and cannot sort, so every page is read and the
 * caller orders the result.
 *
 * @param {{ categoryId: number, token: string, fetchImpl: typeof fetch }} input
 * @returns {Promise<LiveStream[]>}
 */
async function fetchKickStreams({ categoryId, token, fetchImpl }) {
  /** @type {LiveStream[]} */
  const streams = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ category_id: String(categoryId), limit: String(PAGE_SIZE) });
    if (cursor) query.set("cursor", cursor);
    const json = await fetchJson(
      fetchImpl,
      `${KICK_API}/livestreams?${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
      "kick_live_streams",
    );
    streams.push(...compact((Array.isArray(json.data) ? json.data : []).map(normalizeKickStream)));
    cursor = String(json.pagination?.next_cursor || "");
    if (!cursor) break;
  }
  return uniqueById(streams);
}

/**
 * Kick app access token (client-credentials grant).
 *
 * @param {ProviderCredentials} credentials @param {typeof fetch} fetchImpl
 * @returns {Promise<string>}
 */
async function getKickAppToken(credentials, fetchImpl) {
  const json = await postForm(
    fetchImpl,
    "https://id.kick.com/oauth/token",
    {
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    },
    "kick_app_token",
  );
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new PlatformOauthError("kick_token_missing", "Kick did not return an access token");
  }
  return json.access_token;
}

module.exports = {
  TWITCH_STARCRAFT_GAME_ID,
  normalizeLanguage,
  normalizeTwitchStream,
  normalizeKickStream,
  fetchTwitchStreams,
  findKickCategoryId,
  fetchKickStreams,
  getKickAppToken,
};
