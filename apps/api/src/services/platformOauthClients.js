"use strict";

const { createHash, randomBytes } = require("crypto");

const REQUEST_TIMEOUT_MS = 12_000;
const JSON_MAX_BYTES = 512 * 1024;
// A Twitch EventSub conflict names the subscription already holding the slot,
// e.g. "subscription already exists; id=d5ad6ba1-…". Matching the documented id
// shape keeps a surprising body from turning into a delete of something else.
const TWITCH_CONFLICT_ID_PATTERN =
  /\bid[=:]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

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

const TWITCH_EVENT_TYPES = Object.freeze([
  {
    type: "channel.follow",
    version: "2",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id, moderator_user_id: id }),
  },
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.channel_points_automatic_reward_redemption.add",
    version: "2",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscribe",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.message",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.subscription.gift",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.cheer",
    version: "1",
    condition: (/** @type {string} */ id) => ({ broadcaster_user_id: id }),
  },
  {
    type: "channel.raid",
    version: "1",
    condition: (/** @type {string} */ id) => ({ to_broadcaster_user_id: id }),
  },
]);

const KICK_EVENT_TYPES = Object.freeze([
  { name: "channel.followed", version: 1 },
  { name: "channel.subscription.new", version: 1 },
  { name: "channel.subscription.renewal", version: 1 },
  { name: "channel.subscription.gifts", version: 1 },
  { name: "kicks.gifted", version: 1 },
  { name: "channel.reward.redemption.updated", version: 1 },
]);

class PlatformOauthError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 502) {
    super(message);
    this.name = "PlatformOauthError";
    this.code = code;
    this.status = status;
  }
}

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

/** @typedef {{broadcasterUserId:string,appAccessToken:string,clientId:string,callbackUrl:string,webhookSecret:string,fetchImpl?:typeof fetch}} TwitchReconcileArgs */

/** @param {TwitchReconcileArgs} args */
async function reconcileTwitchEventSubscriptions(args) {
  const existing = await listTwitchSubscriptions(args);
  // Twitch answers a create with 409 when a subscription already exists for the
  // same type, version and condition. The transport callback is not part of that
  // identity, so every row holding one of our slots has to be indexed here, not
  // only the healthy ones: a dead status or a callback from an earlier
  // deployment otherwise becomes a conflict that no reconnect can clear.
  /** @type {Map<string, Record<string, any>[]>} */
  const owners = new Map();
  for (const row of existing) {
    const key = twitchSubscriptionKey(row);
    const rows = owners.get(key);
    if (rows) rows.push(row);
    else owners.set(key, [row]);
  }
  const created = [];
  const removed = [];
  for (const spec of TWITCH_EVENT_TYPES) {
    const condition = spec.condition(args.broadcasterUserId);
    const key = `${spec.type}:${spec.version}:${conditionKey(condition)}`;
    const owned = owners.get(key) || [];
    const keeper = owned.find((row) => twitchSubscriptionIsUsable(row, args.callbackUrl));
    const stale = owned.filter((row) => row !== keeper && row?.id);
    if (keeper) {
      // Tidy-up beside a subscription that already works: a leftover row on a
      // retired callback would double every alert that callback still reaches.
      // A provider hiccup here must not fail a healthy connection, so a failed
      // delete is left for the next reconcile.
      removed.push(...await releaseTwitchSlot(args, stale, true));
      continue;
    }
    // EventSub has no update call, so a slot held by a failed verification, an
    // exhausted delivery budget or a retired callback has to be released before
    // the replacement can be created.
    removed.push(...await releaseTwitchSlot(args, stale, false));
    created.push(...await createTwitchSubscription(args, spec, condition));
  }
  return { existing, created, removed };
}

/** @param {TwitchReconcileArgs} args @param {{type:string,version:string}} spec @param {Record<string,any>} condition */
async function createTwitchSubscription(args, spec, condition) {
  try {
    return await postTwitchSubscription(args, spec, condition);
  } catch (err) {
    if (Number(/** @type {any} */ (err)?.status) !== 409) throw err;
    // A row the reconcile never saw still owns this slot — a concurrent
    // reconnect can win the race, and the listing above is filtered to one
    // broadcaster. Release the real owner and try once more instead of parking
    // the connection on "needs retry" until someone reconciles Twitch by hand.
    const released = await releaseTwitchConflict(args, spec, condition, err);
    if (!released) {
      throw new PlatformOauthError(
        "twitch_eventsub_conflict",
        `Twitch reports an existing ${spec.type} subscription that could not be replaced`
        + ` (${safeMessage(err)})`,
        409,
      );
    }
    return await postTwitchSubscription(args, spec, condition);
  }
}

/** @param {TwitchReconcileArgs} args @param {{type:string,version:string}} spec @param {Record<string,any>} condition */
async function postTwitchSubscription(args, spec, condition) {
  const response = await fetchJson(
    args.fetchImpl || fetch,
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.appAccessToken}`,
        "Client-Id": args.clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: spec.type,
        version: spec.version,
        condition,
        transport: {
          method: "webhook",
          callback: args.callbackUrl,
          secret: args.webhookSecret,
        },
      }),
    },
    "twitch_eventsub_create",
  );
  const rows = Array.isArray(response.data) ? response.data : [];
  if (!rows.some((/** @type {any} */ row) => twitchSubscriptionIsActive(row))) {
    throw new PlatformOauthError(
      "twitch_eventsub_create",
      `Twitch did not confirm the ${spec.type} subscription`,
    );
  }
  return rows;
}

/**
 * Deletes the subscriptions still holding a slot. `tolerant` marks opportunistic
 * cleanup that must not break an otherwise healthy reconcile.
 * @param {TwitchReconcileArgs} args
 * @param {Record<string,any>[]} rows
 * @param {boolean} tolerant
 */
async function releaseTwitchSlot(args, rows, tolerant) {
  const removed = [];
  for (const row of rows) {
    try {
      if (await deleteTwitchSubscription(args, String(row.id))) removed.push(row);
    } catch (err) {
      if (!tolerant) throw err;
    }
  }
  return removed;
}

/**
 * Finds and deletes whatever Twitch says already occupies a slot. Twitch names
 * the conflicting id in the 409 body; when it does not, a type-filtered listing
 * locates the owner by matching its condition.
 * @param {TwitchReconcileArgs} args
 * @param {{type:string,version:string}} spec
 * @param {Record<string,any>} condition
 * @param {unknown} err
 */
async function releaseTwitchConflict(args, spec, condition, err) {
  const named = TWITCH_CONFLICT_ID_PATTERN.exec(safeMessage(err));
  if (named && await deleteTwitchSubscription(args, named[1])) return true;
  const key = `${spec.type}:${spec.version}:${conditionKey(condition)}`;
  const rows = await listTwitchSubscriptions({ ...args, broadcasterUserId: "", type: spec.type });
  let released = false;
  for (const row of rows) {
    if (twitchSubscriptionKey(row) !== key || !row?.id) continue;
    if (await deleteTwitchSubscription(args, String(row.id))) released = true;
  }
  return released;
}

/** @param {TwitchReconcileArgs} args @param {string} subscriptionId */
async function deleteTwitchSubscription(args, subscriptionId) {
  if (!subscriptionId) return false;
  const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
  url.searchParams.set("id", subscriptionId);
  try {
    await fetchNoContent(
      args.fetchImpl || fetch,
      url.toString(),
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${args.appAccessToken}`,
          "Client-Id": args.clientId,
        },
      },
      "twitch_eventsub_delete",
    );
    return true;
  } catch (deleteErr) {
    // Already gone is the outcome this call wanted, but it frees no slot that
    // was not free before, so the caller must not treat it as progress.
    if (Number(/** @type {any} */ (deleteErr)?.status) === 404) return false;
    throw deleteErr;
  }
}

/** @param {Record<string, any>} row */
function twitchSubscriptionKey(row) {
  return `${String(row?.type || "")}:${String(row?.version || "")}:${conditionKey(row?.condition || {})}`;
}

/** @param {Record<string, any>} row */
function twitchSubscriptionIsActive(row) {
  return row?.status === "enabled"
    || row?.status === "webhook_callback_verification_pending";
}

/** @param {Record<string, any>} row @param {string} callbackUrl */
function twitchSubscriptionIsUsable(row, callbackUrl) {
  return twitchSubscriptionIsActive(row)
    && row?.transport?.method === "webhook"
    && row?.transport?.callback === callbackUrl;
}

/** @param {{appAccessToken:string,clientId:string,broadcasterUserId?:string,type?:string,fetchImpl?:typeof fetch}} args */
async function listTwitchSubscriptions(args) {
  const rows = [];
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const url = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
    // EventSub accepts one filter per call. The user_id condition filter avoids
    // scanning every customer subscription owned by the app as the installation
    // grows; the type filter is the bounded way to locate a conflicting row that
    // the broadcaster-scoped listing did not return.
    if (args.type) {
      url.searchParams.set("type", args.type);
    } else if (args.broadcasterUserId) {
      url.searchParams.set("user_id", args.broadcasterUserId);
    }
    if (cursor) url.searchParams.set("after", cursor);
    const json = await fetchJson(
      args.fetchImpl || fetch,
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${args.appAccessToken}`,
          "Client-Id": args.clientId,
        },
      },
      "twitch_eventsub_list",
    );
    rows.push(...(Array.isArray(json.data) ? json.data : []));
    cursor = String(json.pagination?.cursor || "");
    if (!cursor) break;
  }
  if (cursor) {
    throw new PlatformOauthError(
      "twitch_eventsub_list",
      "Twitch returned more EventSub pages than could be reconciled safely",
    );
  }
  return rows;
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

/** @param {Record<string, any>} condition */
function conditionKey(condition) {
  return Object.entries(condition || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {Record<string,string>} fields @param {string} code */
async function postForm(fetchImpl, url, fields, code) {
  return fetchJson(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    code,
  );
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {RequestInit} init @param {string} code */
async function fetchJson(fetchImpl, url, init, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlatformOauthError(code, `${code} request failed: ${safeError(err)}`);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = await readBoundedText(response, JSON_MAX_BYTES);
      const parsed = JSON.parse(body);
      detail = String(parsed.message || parsed.error_description || parsed.error || "").slice(0, 160);
    } catch {
      detail = "";
    }
    throw new PlatformOauthError(
      code,
      `${code} returned ${response.status}${detail ? `: ${detail}` : ""}`,
      response.status,
    );
  }
  const body = await readBoundedText(response, JSON_MAX_BYTES);
  try {
    return JSON.parse(body);
  } catch {
    throw new PlatformOauthError(code, `${code} returned invalid JSON`);
  }
}

/** @param {typeof fetch} fetchImpl @param {string} url @param {RequestInit} init @param {string} code */
async function fetchNoContent(fetchImpl, url, init, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlatformOauthError(code, `${code} request failed: ${safeError(err)}`);
  }
  if (response.ok) return;
  let detail = "";
  try {
    const body = await readBoundedText(response, JSON_MAX_BYTES);
    try {
      const parsed = JSON.parse(body);
      detail = String(parsed.message || parsed.error_description || parsed.error || "");
    } catch {
      detail = body;
    }
  } catch {
    detail = "";
  }
  throw new PlatformOauthError(
    code,
    `${code} returned ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    response.status,
  );
}

/** @param {Response} response @param {number} maxBytes */
async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error("response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("response_too_large");
  return text;
}

/** @param {unknown} err */
function safeError(err) {
  return err instanceof Error ? err.name : "network error";
}

/** @param {unknown} err */
function safeMessage(err) {
  return (err instanceof Error ? err.message : String(err || "")).slice(0, 200);
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
};
