"use strict";

const { createHash, randomBytes } = require("crypto");

const {
  PlatformOauthError,
  postForm,
  fetchJson,
  fetchNoContent,
} = require("./platformOauthHttp");
// Twitch EventSub reconciliation lives in its own module; it is re-exported here
// so `platformOauthClients` stays the single provider surface for callers.
const {
  TWITCH_EVENT_TYPES,
  reconcileTwitchEventSubscriptions,
} = require("./twitchEventSubscriptions");

/** @typedef {{clientId:string,clientSecret:string,redirectUri:string,callbackUrl?:string,webhookSecret?:string}} ProviderConfig */

const TWITCH_SCOPES = Object.freeze([
  "moderator:read:followers",
  "channel:read:redemptions",
  "channel:read:subscriptions",
  "bits:read",
]);
const KICK_SCOPES = Object.freeze([
  "user:read",
  "channel:read",
  "events:subscribe",
]);
const YOUTUBE_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/youtube.readonly",
]);
const YOUTUBE_UPLOAD_PAGE_LIMIT = 3;
const YOUTUBE_UPLOAD_PAGE_SIZE = 50;
const YOUTUBE_VIDEO_BATCH_SIZE = 50;
const YOUTUBE_ONGOING_GRACE_MS = 10 * 60 * 1000;
const YOUTUBE_GAME_VODS_TIMEOUT_MS = 18_000;

const KICK_EVENT_TYPES = Object.freeze([
  { name: "channel.followed", version: 1 },
  { name: "channel.subscription.new", version: 1 },
  { name: "channel.subscription.renewal", version: 1 },
  { name: "channel.subscription.gifts", version: 1 },
  { name: "kicks.gifted", version: 1 },
  { name: "channel.reward.redemption.updated", version: 1 },
]);

function createPkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return { verifier, challenge };
}

/** @param {URL} url @param {Record<string, string|readonly string[]>} params */
function setQuery(url, params) {
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, typeof value === "string" ? value : value.join(" "));
  }
  return url;
}

/** @param {ProviderConfig} config @param {string} state */
function buildTwitchAuthorizeUrl(config, state) {
  return setQuery(new URL("https://id.twitch.tv/oauth2/authorize"), {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: TWITCH_SCOPES,
    state,
  }).toString();
}

/** @param {ProviderConfig} config @param {string} state @param {string} challenge */
function buildKickAuthorizeUrl(config, state, challenge) {
  return setQuery(new URL("https://id.kick.com/oauth/authorize"), {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: KICK_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
}

/** @param {ProviderConfig} config @param {string} state */
function buildYoutubeAuthorizeUrl(config, state) {
  return setQuery(new URL("https://accounts.google.com/o/oauth2/v2/auth"), {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: YOUTUBE_SCOPES,
    state,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  }).toString();
}

/** @param {ProviderConfig} config @param {string} code @param {typeof fetch} [fetchImpl] */
async function exchangeTwitchCode(config, code, fetchImpl = fetch) {
  const json = await postForm(
    fetchImpl,
    "https://id.twitch.tv/oauth2/token",
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    },
    "twitch_token_exchange",
  );
  return normalizeTokenResponse(json, "twitch");
}

/** @param {ProviderConfig} config @param {string} refreshToken @param {typeof fetch} [fetchImpl] */
async function refreshTwitchToken(config, refreshToken, fetchImpl = fetch) {
  const json = await postForm(
    fetchImpl,
    "https://id.twitch.tv/oauth2/token",
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    "twitch_token_refresh",
  );
  const token = normalizeTokenResponse(json, "twitch");
  token.refreshToken = token.refreshToken || refreshToken;
  return token;
}

/** @param {string} accessToken @param {typeof fetch} [fetchImpl] */
async function validateTwitchUserToken(accessToken, fetchImpl = fetch) {
  const json = await fetchJson(
    fetchImpl,
    "https://id.twitch.tv/oauth2/validate",
    { headers: { Authorization: `OAuth ${accessToken}` } },
    "twitch_token_validate",
  );
  if (!json.user_id) {
    throw new PlatformOauthError("twitch_identity_missing", "Twitch did not return a user id");
  }
  return {
    userId: String(json.user_id),
    userName: String(json.login || ""),
    scopes: Array.isArray(json.scopes) ? json.scopes.map(String) : [],
    expiresInSeconds: Number.isFinite(Number(json.expires_in))
      ? Math.max(0, Number(json.expires_in))
      : null,
  };
}

/** @param {ProviderConfig} config @param {typeof fetch} [fetchImpl] */
async function getTwitchAppToken(config, fetchImpl = fetch) {
  const json = await postForm(
    fetchImpl,
    "https://id.twitch.tv/oauth2/token",
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "client_credentials",
    },
    "twitch_app_token",
  );
  return normalizeTokenResponse(json, "twitch").accessToken;
}

/** @param {ProviderConfig} config @param {string} code @param {string} verifier @param {typeof fetch} [fetchImpl] */
async function exchangeKickCode(config, code, verifier, fetchImpl = fetch) {
  const json = await postForm(
    fetchImpl,
    "https://id.kick.com/oauth/token",
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
      code,
    },
    "kick_token_exchange",
  );
  return normalizeTokenResponse(json, "kick");
}

/** @param {ProviderConfig} config @param {string} refreshToken @param {typeof fetch} [fetchImpl] */
async function refreshKickToken(config, refreshToken, fetchImpl = fetch) {
  const json = await postForm(
    fetchImpl,
    "https://id.kick.com/oauth/token",
    {
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    "kick_token_refresh",
  );
  const token = normalizeTokenResponse(json, "kick");
  // Kick normally rotates refresh tokens. Retaining the current value is a
  // safe fallback for a conforming response that omits a replacement.
  token.refreshToken = token.refreshToken || refreshToken;
  return token;
}

/** @param {string} accessToken @param {typeof fetch} [fetchImpl] */
async function getKickCurrentUser(accessToken, fetchImpl = fetch) {
  const json = await fetchJson(
    fetchImpl,
    "https://api.kick.com/public/v1/users",
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "kick_current_user",
  );
  const user = Array.isArray(json.data) ? json.data[0] : json.data;
  if (!user?.user_id) {
    throw new PlatformOauthError("kick_identity_missing", "Kick did not return a user id");
  }
  return {
    userId: String(user.user_id),
    userName: String(user.name || user.username || ""),
  };
}

/** @param {string} accessToken @param {typeof fetch} [fetchImpl] */
async function subscribeKickEvents(accessToken, fetchImpl = fetch) {
  const existing = await listKickEventSubscriptions(accessToken, fetchImpl);
  const existingKeys = new Set(existing.map(kickSubscriptionKey));
  const missing = KICK_EVENT_TYPES.filter((event) =>
    !existingKeys.has(kickSubscriptionKey({
      event: event.name,
      version: event.version,
      method: "webhook",
    })));
  if (missing.length === 0) return { existing, created: [] };
  const json = await fetchJson(
    fetchImpl,
    "https://api.kick.com/public/v1/events/subscriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: missing, method: "webhook" }),
    },
    "kick_event_subscribe",
  );
  const created = Array.isArray(json.data) ? json.data : [];
  for (const expected of missing) {
    const result = created.find((/** @type {any} */ row) =>
      String(row?.name || row?.event || "") === expected.name
      && (Number(row?.version) || 1) === expected.version);
    if (!result || result.error) {
      const detail = String(result?.error || "Kick did not confirm the subscription")
        .slice(0, 160);
      throw new PlatformOauthError(
        "kick_event_subscribe",
        `Kick could not subscribe to ${expected.name}: ${detail}`,
      );
    }
  }
  return {
    existing,
    created,
  };
}

/** @param {string} accessToken @param {typeof fetch} [fetchImpl] */
async function listKickEventSubscriptions(accessToken, fetchImpl = fetch) {
  const json = await fetchJson(
    fetchImpl,
    "https://api.kick.com/public/v1/events/subscriptions",
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "kick_event_subscriptions_list",
  );
  return Array.isArray(json.data) ? json.data : [];
}

/** @param {{event?:unknown,name?:unknown,version?:unknown,method?:unknown}} row */
function kickSubscriptionKey(row) {
  return `${String(row?.event || row?.name || "")}:${Number(row?.version) || 1}:${String(row?.method || "")}`;
}

/** @param {ProviderConfig} config @param {string} accessToken @param {typeof fetch} [fetchImpl] */
async function revokeTwitchToken(config, accessToken, fetchImpl = fetch) {
  if (!accessToken) return;
  await fetchNoContent(
    fetchImpl,
    "https://id.twitch.tv/oauth2/revoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        token: accessToken,
      }).toString(),
    },
    "twitch_token_revoke",
  );
}

/** @param {string} token @param {typeof fetch} [fetchImpl] */
async function revokeKickToken(token, fetchImpl = fetch) {
  if (!token) return;
  const url = new URL("https://id.kick.com/oauth/revoke");
  url.searchParams.set("token", token);
  await fetchNoContent(
    fetchImpl,
    url.toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
    "kick_token_revoke",
  );
}

/** @param {string} token @param {typeof fetch} [fetchImpl] */
async function revokeYoutubeToken(token, fetchImpl = fetch) {
  if (!token) return;
  await fetchNoContent(
    fetchImpl,
    "https://oauth2.googleapis.com/revoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    },
    "youtube_token_revoke",
  );
}

/** @param {ProviderConfig} config @param {string} code @param {typeof fetch} [fetchImpl] */
async function exchangeYoutubeCode(config, code, fetchImpl = fetch) {
  const json = await postForm(
    fetchImpl,
    "https://oauth2.googleapis.com/token",
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    },
    "youtube_token_exchange",
  );
  return normalizeTokenResponse(json, "youtube");
}

/** @param {ProviderConfig} config @param {string} refreshToken @param {typeof fetch} [fetchImpl] */
async function refreshYoutubeToken(config, refreshToken, fetchImpl = fetch) {
  const json = await postForm(
    fetchImpl,
    "https://oauth2.googleapis.com/token",
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    "youtube_token_refresh",
  );
  const token = normalizeTokenResponse(json, "youtube");
  token.refreshToken = refreshToken;
  return token;
}

/** @param {string} accessToken @param {typeof fetch} [fetchImpl] */
async function getYoutubeCurrentChannel(accessToken, fetchImpl = fetch) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id,snippet");
  url.searchParams.set("mine", "true");
  const json = await fetchJson(
    fetchImpl,
    url.toString(),
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "youtube_current_channel",
  );
  const channel = Array.isArray(json.items) ? json.items[0] : null;
  if (!channel?.id) {
    throw new PlatformOauthError(
      "youtube_channel_missing",
      "The selected Google account does not have a YouTube channel",
      400,
    );
  }
  return { userId: String(channel.id), userName: String(channel.snippet?.title || "") };
}

/** @param {string} accessToken @param {typeof fetch} [fetchImpl] */
async function listYoutubeRecentSubscribers(accessToken, fetchImpl = fetch) {
  const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
  url.searchParams.set("part", "snippet,subscriberSnippet");
  url.searchParams.set("myRecentSubscribers", "true");
  url.searchParams.set("maxResults", "50");
  const json = await fetchJson(
    fetchImpl,
    url.toString(),
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "youtube_recent_subscribers",
  );
  return Array.isArray(json.items) ? json.items : [];
}

/**
 * List recent livestream archives owned by the authenticated YouTube channel.
 * The uploads playlist is the authoritative, channel-owned index; paging is
 * capped at 150 uploads (three 50-item pages), which comfortably covers a
 * typical SC2 season without turning a game-history request into an unbounded
 * provider crawl. Video details are fetched in YouTube's maximum 50-id
 * batches. Partial-response fields keep every response inside the shared
 * bounded JSON reader.
 *
 * @param {string} accessToken
 * @param {typeof fetch} [fetchImpl]
 * @param {{
 *   maxPages?:number,
 *   nowMs?:number,
 *   expectedHandle?:string,
 *   expectedChannelId?:string,
 *   signal?:AbortSignal,
 * }} [opts]
 * @returns {Promise<{
 *   channelId:string,
 *   customUrl:string,
 *   handleLookupAttempted:boolean,
 *   handleChannelId:string,
 *   vods:Array<{
 *     platform:'youtube',videoId:string,startMs:number,endMs:number,
 *     orientation:'horizontal'|'portrait'|'unknown',ongoing:boolean,
 *   }>,
 *   uploadsScanned:number,
 *   pagesFetched:number,
 *   videoBatches:number,
 * }>}
 */
async function listYoutubeGameVods(
  accessToken,
  fetchImpl = fetch,
  opts = {},
) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const timeoutSignal = AbortSignal.timeout(YOUTUBE_GAME_VODS_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  const channelsUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelsUrl.searchParams.set("part", "contentDetails,snippet");
  channelsUrl.searchParams.set("mine", "true");
  channelsUrl.searchParams.set(
    "fields",
    "items(id,snippet/customUrl,contentDetails/relatedPlaylists/uploads)",
  );
  const channels = await fetchJson(
    fetchImpl,
    channelsUrl.toString(),
    { headers: auth, signal },
    "youtube_game_vods_channel",
  );
  const channel = Array.isArray(channels.items) ? channels.items[0] : null;
  const channelId = String(channel?.id || "");
  const uploadsPlaylistId = String(
    channel?.contentDetails?.relatedPlaylists?.uploads || "",
  );
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId) || !uploadsPlaylistId) {
    throw new PlatformOauthError(
      "youtube_game_vods_channel_missing",
      "YouTube did not return the authenticated channel uploads playlist",
    );
  }

  const expectedChannelId = typeof opts.expectedChannelId === "string"
    && /^UC[A-Za-z0-9_-]{22}$/.test(opts.expectedChannelId)
    ? opts.expectedChannelId
    : "";
  if (expectedChannelId && expectedChannelId !== channelId) {
    return {
      channelId,
      customUrl: String(channel?.snippet?.customUrl || ""),
      handleLookupAttempted: false,
      handleChannelId: "",
      vods: [],
      uploadsScanned: 0,
      pagesFetched: 0,
      videoBatches: 0,
    };
  }

  const expectedHandle = normalizeYoutubeHandle(opts.expectedHandle);
  let handleChannelId = "";
  if (expectedHandle) {
    const handleUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
    handleUrl.searchParams.set("part", "id");
    handleUrl.searchParams.set("forHandle", expectedHandle.slice(1));
    handleUrl.searchParams.set("fields", "items/id");
    const handleResult = await fetchJson(
      fetchImpl,
      handleUrl.toString(),
      { headers: auth, signal },
      "youtube_game_vods_handle",
    );
    handleChannelId = String(
      Array.isArray(handleResult.items) ? handleResult.items[0]?.id || "" : "",
    );
    // A saved handle pointing at another channel cannot use this bearer. Stop
    // before spending quota on that connected account's uploads and videos;
    // the caller will fall back to the saved channel's public page instead.
    if (handleChannelId !== channelId) {
      return {
        channelId,
        customUrl: String(channel?.snippet?.customUrl || ""),
        handleLookupAttempted: true,
        handleChannelId,
        vods: [],
        uploadsScanned: 0,
        pagesFetched: 0,
        videoBatches: 0,
      };
    }
  }

  const requestedPages = Math.floor(Number(opts.maxPages));
  const maxPages = Number.isFinite(requestedPages) && requestedPages > 0
    ? Math.min(YOUTUBE_UPLOAD_PAGE_LIMIT, requestedPages)
    : YOUTUBE_UPLOAD_PAGE_LIMIT;
  const videoIds = [];
  const seen = new Set();
  let pageToken = "";
  let pagesFetched = 0;
  do {
    const playlistUrl = new URL(
      "https://www.googleapis.com/youtube/v3/playlistItems",
    );
    playlistUrl.searchParams.set("part", "contentDetails");
    playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
    playlistUrl.searchParams.set("maxResults", String(YOUTUBE_UPLOAD_PAGE_SIZE));
    playlistUrl.searchParams.set(
      "fields",
      "nextPageToken,items/contentDetails/videoId",
    );
    if (pageToken) playlistUrl.searchParams.set("pageToken", pageToken);
    const page = await fetchJson(
      fetchImpl,
      playlistUrl.toString(),
      { headers: auth, signal },
      "youtube_game_vods_uploads",
    );
    pagesFetched += 1;
    for (const item of Array.isArray(page.items) ? page.items : []) {
      const videoId = String(item?.contentDetails?.videoId || "");
      if (!isYoutubeVideoId(videoId) || seen.has(videoId)) continue;
      seen.add(videoId);
      videoIds.push(videoId);
      if (videoIds.length >= maxPages * YOUTUBE_UPLOAD_PAGE_SIZE) break;
    }
    pageToken = String(page.nextPageToken || "");
  } while (
    pageToken
    && pagesFetched < maxPages
    && videoIds.length < maxPages * YOUTUBE_UPLOAD_PAGE_SIZE
  );

  const detailRequests = [];
  for (let start = 0; start < videoIds.length; start += YOUTUBE_VIDEO_BATCH_SIZE) {
    const ids = videoIds.slice(start, start + YOUTUBE_VIDEO_BATCH_SIZE);
    const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    videosUrl.searchParams.set("part", "liveStreamingDetails,player,snippet");
    videosUrl.searchParams.set("id", ids.join(","));
    videosUrl.searchParams.set("maxWidth", "1920");
    videosUrl.searchParams.set("maxHeight", "1080");
    videosUrl.searchParams.set(
      "fields",
      "items(id,liveStreamingDetails/actualStartTime," +
        "liveStreamingDetails/actualEndTime,player/embedWidth," +
        "player/embedHeight,snippet/liveBroadcastContent)",
    );
    detailRequests.push(fetchJson(
      fetchImpl,
      videosUrl.toString(),
      { headers: auth, signal },
      "youtube_game_vods_videos",
    ));
  }
  const detailed = [];
  const detailBatches = await Promise.all(detailRequests);
  for (const batch of detailBatches) {
    detailed.push(...parseYoutubeGameVodItems(batch, opts.nowMs));
  }

  return {
    channelId,
    customUrl: String(channel?.snippet?.customUrl || ""),
    handleLookupAttempted: Boolean(expectedHandle),
    handleChannelId,
    vods: detailed.map(({ platform, videoId, startMs, endMs, width, height, ongoing }) => ({
      platform,
      videoId,
      startMs,
      endMs,
      orientation: youtubeVodOrientation(width, height),
      ongoing,
    })),
    uploadsScanned: videoIds.length,
    pagesFetched,
    videoBatches: detailBatches.length,
  };
}

/**
 * @param {Record<string,any>} payload
 * @param {number} [nowMs]
 * @returns {Array<{
 *   platform:'youtube',videoId:string,startMs:number,endMs:number,
 *   width:number|null,height:number|null,ongoing:boolean,
 * }>}
 */
function parseYoutubeGameVodItems(payload, nowMs = Date.now()) {
  /** @type {Array<{
   *   platform:'youtube',videoId:string,startMs:number,endMs:number,
   *   width:number|null,height:number|null,ongoing:boolean,
   * }>} */
  const vods = [];
  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    const videoId = String(item?.id || "");
    const startMs = parseProviderDateMs(
      item?.liveStreamingDetails?.actualStartTime,
    );
    if (!isYoutubeVideoId(videoId) || startMs === null) continue;
    const actualEndMs = parseProviderDateMs(
      item?.liveStreamingDetails?.actualEndTime,
    );
    if (
      actualEndMs === null
      && item?.snippet?.liveBroadcastContent !== "live"
    ) {
      continue;
    }
    const ongoingEndMs = Number.isFinite(nowMs)
      ? Number(nowMs) + YOUTUBE_ONGOING_GRACE_MS
      : Date.now() + YOUTUBE_ONGOING_GRACE_MS;
    const endMs = actualEndMs === null
      ? Math.max(startMs + 1, ongoingEndMs)
      : actualEndMs;
    if (endMs <= startMs) continue;
    const width = positiveProviderNumber(item?.player?.embedWidth);
    const height = positiveProviderNumber(item?.player?.embedHeight);
    vods.push({
      platform: "youtube",
      videoId,
      startMs,
      endMs,
      width,
      height,
      ongoing: actualEndMs === null,
    });
  }
  return vods;
}

/**
 * @param {number|null} width
 * @param {number|null} height
 * @returns {'horizontal'|'portrait'|'unknown'}
 */
function youtubeVodOrientation(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "unknown";
  return Number(width) >= Number(height) ? "horizontal" : "portrait";
}

/** @param {unknown} value @returns {number|null} */
function parseProviderDateMs(value) {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {unknown} value @returns {number|null} */
function positiveProviderNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** @param {unknown} value @returns {string|null} */
function normalizeYoutubeHandle(value) {
  const handle = typeof value === "string" ? value.trim() : "";
  return /^@[A-Za-z0-9._-]{2,60}$/.test(handle)
    ? handle.toLowerCase()
    : null;
}

/** @param {unknown} value */
function isYoutubeVideoId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

/** @param {any} json @param {string} platform */
function normalizeTokenResponse(json, platform) {
  if (!json || typeof json.access_token !== "string" || !json.access_token) {
    throw new PlatformOauthError(`${platform}_token_missing`, `${platform} did not return an access token`);
  }
  const expiresIn = Math.max(0, Number(json.expires_in) || 0);
  return {
    accessToken: json.access_token,
    refreshToken:
      typeof json.refresh_token === "string" && json.refresh_token
        ? json.refresh_token
        : null,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes: Array.isArray(json.scope)
      ? json.scope.map(String)
      : typeof json.scope === "string"
        ? json.scope.split(/\s+/).filter(Boolean)
        : [],
  };
}

module.exports = {
  PlatformOauthError,
  TWITCH_SCOPES,
  KICK_SCOPES,
  YOUTUBE_SCOPES,
  TWITCH_EVENT_TYPES,
  KICK_EVENT_TYPES,
  createPkcePair,
  buildTwitchAuthorizeUrl,
  buildKickAuthorizeUrl,
  buildYoutubeAuthorizeUrl,
  exchangeTwitchCode,
  refreshTwitchToken,
  validateTwitchUserToken,
  getTwitchAppToken,
  reconcileTwitchEventSubscriptions,
  exchangeKickCode,
  refreshKickToken,
  getKickCurrentUser,
  listKickEventSubscriptions,
  subscribeKickEvents,
  revokeTwitchToken,
  revokeKickToken,
  revokeYoutubeToken,
  exchangeYoutubeCode,
  refreshYoutubeToken,
  getYoutubeCurrentChannel,
  listYoutubeRecentSubscribers,
  listYoutubeGameVods,
  parseYoutubeGameVodItems,
  YOUTUBE_UPLOAD_PAGE_LIMIT,
  YOUTUBE_ONGOING_GRACE_MS,
};
