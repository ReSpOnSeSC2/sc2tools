"use strict";

/**
 * Which Twitch channel a past broadcast belongs to. SC2Pulse's VOD links name
 * only the video, so the ladder VOD finder asks Twitch (`helix/videos`, one
 * call for up to 100 videos) with the server's own app token. A video's owner
 * never changes, so answers are kept; a failed lookup is not.
 */

const { getTwitchAppToken } = require("./platformOauthClients");
const { PlatformOauthError, fetchJson } = require("./platformOauthHttp");

const VIDEOS_URL = "https://api.twitch.tv/helix/videos";
const MAX_IDS_PER_CALL = 100;
const MAX_KNOWN_VIDEOS = 5000;
/** Same lifetime the live list gives its provider tokens. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

/** @typedef {import("./liveStreamProviders").ProviderCredentials} ProviderCredentials */
/** @typedef {(videoIds: string[]) => Promise<Map<string, string>>} ChannelResolver */

/**
 * @param {{ credentials: ProviderCredentials | null, fetchImpl?: typeof fetch, now?: () => number }} options
 * @returns {ChannelResolver} video id to channel login, for the videos Twitch answered for
 */
function buildTwitchVideoChannelResolver({ credentials, fetchImpl = fetch, now = Date.now }) {
  /** @type {Map<string, string>} */
  const known = new Map();
  /** @type {{ token: string, at: number } | null} */
  let token = null;

  async function appToken() {
    if (token && now() - token.at < TOKEN_TTL_MS) return token.token;
    token = { token: await getTwitchAppToken(/** @type {ProviderCredentials} */ (credentials), fetchImpl), at: now() };
    return token.token;
  }

  /** @param {string[]} ids */
  async function lookUp(ids) {
    const query = new URLSearchParams();
    ids.forEach(id => query.append("id", id));
    const headers = { "Client-Id": /** @type {ProviderCredentials} */ (credentials).clientId, Authorization: `Bearer ${await appToken()}` };
    const json = await fetchJson(fetchImpl, `${VIDEOS_URL}?${query}`, { headers }, "twitch_videos").catch(err => {
      // A revoked or rotated token is dropped so the next search gets a fresh one.
      if (err instanceof PlatformOauthError && err.status === 401) token = null;
      throw err;
    });
    for (const video of Array.isArray(json.data) ? json.data : []) {
      if (typeof video?.id === "string" && typeof video.user_login === "string" && video.user_login) {
        known.set(video.id, video.user_login);
      }
    }
    while (known.size > MAX_KNOWN_VIDEOS) known.delete(/** @type {string} */ (known.keys().next().value));
  }

  return async videoIds => {
    const missing = [...new Set(videoIds)].filter(id => !known.has(id)).slice(0, MAX_IDS_PER_CALL);
    if (credentials && missing.length > 0) await lookUp(missing);
    return new Map(videoIds.flatMap(id => (known.has(id) ? [[id, /** @type {string} */ (known.get(id))]] : [])));
  };
}

module.exports = { buildTwitchVideoChannelResolver };
