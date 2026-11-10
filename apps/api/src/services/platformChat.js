"use strict";

const { CHAT_SCOPES } = require("./platformOauthClients");
const { fetchJson } = require("./platformOauthHttp");
const { normalizeYoutubeInput } = require("./youtubeLiveChat");

/** @type {Readonly<Record<string,number>>} */
const MAX_LENGTH = Object.freeze({ twitch: 500, kick: 500, youtube: 200, tiktok: 500 });
/** @type {Readonly<Record<string,string>>} */
const LABEL = Object.freeze({ twitch: "Twitch", kick: "Kick", youtube: "YouTube", tiktok: "TikTok" });
/** @typedef {'twitch'|'kick'|'youtube'} Platform */
/** @typedef {{accessToken:string,platformUserId:string,platformUserName:string,
 * boundedFetch:typeof fetch,assertCurrent:()=>Promise<void>}} ChatGrant */

/** Only these fixed, safe messages may cross the Dock's token API. */
class PlatformChatError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {boolean} [deliveryUnknown] */
  constructor(status, code, message, deliveryUnknown = false) {
    super(message); this.name = "PlatformChatError"; this.status = status; this.code = code;
    this.deliveryUnknown = deliveryUnknown;
  }
}

/** @param {unknown} error @param {string} platform */
function safeChatError(error, platform) {
  if (error instanceof PlatformChatError) return error;
  const detail = /** @type {any} */ (error);
  if (detail?.code === "streaming_account_busy") {
    return new PlatformChatError(409, "chat_account_busy", "Another operation is using this account. Try again shortly.");
  }
  if (["streaming_consent_required", "streaming_scopes_missing", "streaming_client_mismatch",
    "streaming_identity_mismatch", "streaming_reconnect_required"].includes(detail?.code)
    || detail?.status === 401) {
    return new PlatformChatError(403, "chat_consent_required", `Connect ${LABEL[platform]} chat sending in Settings and approve its permissions.`);
  }
  if (detail?.status === 429) return new PlatformChatError(429, "chat_rate_limited", `${LABEL[platform]} is limiting messages. Wait before sending again.`);
  return new PlatformChatError(502, "chat_send_unconfirmed", `${LABEL[platform]} did not confirm this message. Check its chat before retrying.`, true);
}

/** @param {string} platform @param {unknown} value */
function validateChatText(platform, value) {
  if (typeof value !== "string" || /[\p{Cc}\u2028\u2029]/u.test(value)
    || !value.trim() || value.length > MAX_LENGTH[platform]
    || Array.from(value).some(character => {
      const point = character.codePointAt(0);
      return point !== undefined && point >= 0xd800 && point <= 0xdfff;
    }) || platform === "kick" && Buffer.byteLength(value, "utf8") > 2048) {
    throw new PlatformChatError(400, "chat_text_invalid", `Use a message of 1–${MAX_LENGTH[platform]} characters without control characters.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {'twitch'|'kick'} platform */
function channelName(value, platform) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^[#@]?[A-Za-z0-9_-]{2,60}$/.test(raw)) return raw.replace(/^[#@]/, "").toLowerCase();
  try {
    const url = new URL(raw);
    if ((platform === "twitch" ? ["twitch.tv", "www.twitch.tv"] : ["kick.com", "www.kick.com"]).includes(url.hostname)
      && /^\/[A-Za-z0-9_-]{2,60}\/?$/.test(url.pathname)) return url.pathname.replaceAll("/", "").toLowerCase();
  } catch { /* invalid saved channel */ }
  return "";
}

class PlatformChatService {
  /** @param {{integrations:import('./platformIntegrations').PlatformIntegrationsService}} deps */
  constructor({ integrations }) { this.integrations = integrations; }

  /** Checks permission and destination without sending any message.
   * @param {string} userId @param {Record<string,any>} config */
  async status(userId, config) {
    const connected = await this.integrations.statuses(userId);
    const rows = new Map(connected.platforms.map(row => [row.platform, row]));
    return Promise.all(Object.keys(MAX_LENGTH).map(async platform => {
      const row = rows.get(platform);
      const base = { platform, available: false, identity: "", maxLength: MAX_LENGTH[platform] };
      if (platform === "tiktok") return { ...base, reason: "TikTok chat sending is unavailable. Reply in TikTok." };
      if (!config?.[platform]?.enabled || !config[platform].channel) return { ...base, reason: `Configure ${LABEL[platform]} chat in Settings first.` };
      if (!row?.configured || !row.chatAvailable) return { ...base, reason: `${LABEL[platform]} chat sending is unavailable on this server.` };
      if (!row.connected || !row.chatConsent || !CHAT_SCOPES[/** @type {Platform} */ (platform)].every(scope => row.scopes.includes(scope))) {
        return { ...base, reason: `Connect ${LABEL[platform]} chat sending in Settings and approve its permissions.` };
      }
      try {
        return await this.integrations.withChatGrant(userId, /** @type {Platform} */ (platform), async grant => {
          const destinations = await this._destinations(/** @type {Platform} */ (platform), grant, config);
          return { ...base, available: true, identity: grant.platformUserName || grant.platformUserId,
            ...(platform === "youtube" && destinations.length > 1 ? { reason: `Sends to ${destinations.length} active YouTube live chats.` } : {}) };
        });
      } catch (error) { return { ...base, reason: safeChatError(error, platform).message }; }
    }));
  }

  /** A provider POST is made once. A lost receipt is never retried here.
   * @param {string} userId @param {string} platform @param {unknown} value @param {Record<string,any>} config */
  async send(userId, platform, value, config) {
    if (!["twitch", "kick", "youtube"].includes(platform)) {
      throw new PlatformChatError(400, "chat_platform_unsupported", "TikTok chat sending is unavailable. Reply in TikTok.");
    }
    const text = validateChatText(platform, value);
    if (!config?.[platform]?.enabled || !config[platform].channel) throw new PlatformChatError(409, "chat_not_configured", `Configure ${LABEL[platform]} chat in Settings first.`);
    try {
      return await this.integrations.withChatGrant(userId, /** @type {Platform} */ (platform), async grant => {
        const destinations = await this._destinations(/** @type {Platform} */ (platform), grant, config);
        let confirmed = 0, unknown = 0;
        for (const destination of destinations) {
          try {
            await grant.assertCurrent();
            await this._sendOne(/** @type {Platform} */ (platform), grant, destination, text);
            confirmed += 1;
          } catch (error) {
            if (destinations.length === 1) throw error;
            if (/** @type {any} */ (error)?.deliveryUnknown === true) unknown += 1;
            // Each remaining YouTube chat is a separate configured destination.
            // Continue without replaying a failed or unconfirmed POST.
          }
        }
        if (unknown) return { status: "unknown", message: `Confirmed in ${confirmed} of ${destinations.length} YouTube live chats; delivery to ${unknown} chat${unknown === 1 ? " is" : "s is"} unconfirmed. Check those chats before sending again.` };
        if (!confirmed) throw new PlatformChatError(502, "chat_message_rejected", "YouTube did not accept this message. Check its live chats before retrying.");
        return { status: confirmed < destinations.length ? "unknown" : "sent", message: platform === "youtube" && destinations.length > 1
          ? `Sent to ${confirmed} of ${destinations.length} YouTube live chats.${confirmed < destinations.length ? " Some chats did not confirm delivery; check them before retrying." : ""}`
          : `Sent as ${grant.platformUserName || grant.platformUserId} on ${LABEL[platform]}.` };
      });
    } catch (error) { throw safeChatError(error, platform); }
  }

  /** @param {Platform} platform @param {ChatGrant} grant @param {Record<string,any>} config */
  async _destinations(platform, grant, config) {
    if (platform === "twitch") {
      const saved = channelName(config.twitch.channel, "twitch");
      if (!saved || saved !== grant.platformUserName.toLowerCase()) throw this._mismatch("Twitch");
      return [grant.platformUserId];
    }
    if (platform === "kick") {
      const saved = channelName(config.kick.channel, "kick");
      const url = `https://api.kick.com/public/v1/channels?broadcaster_user_id=${encodeURIComponent(grant.platformUserId)}`;
      const json = await this._json(grant, url);
      const channel = Array.isArray(json.data) ? json.data.find((/** @type {any} */ row) => String(row.broadcaster_user_id) === grant.platformUserId) : null;
      if (!saved || saved !== String(channel?.slug || "").toLowerCase()) throw this._mismatch("Kick");
      return [grant.platformUserId];
    }
    return this._youtubeDestinations(grant, config.youtube.channel);
  }

  /** @param {ChatGrant} grant @param {string} input */
  async _youtubeDestinations(grant, input) {
    let normalized;
    try { normalized = normalizeYoutubeInput(input); }
    catch { throw this._mismatch("YouTube"); }
    if (!normalized.videoId) {
      const source = new URL(normalized.pageUrls[0]);
      const path = source.pathname.replace(/\/live$/, "");
      const params = new URLSearchParams({ part: "id", maxResults: "1" });
      if (path.startsWith("/@")) params.set("forHandle", decodeURIComponent(path.slice(1)));
      else if (path.startsWith("/channel/")) params.set("id", path.slice(9));
      else if (path.startsWith("/user/")) params.set("forUsername", decodeURIComponent(path.slice(6)));
      else throw new PlatformChatError(409, "chat_channel_mismatch", "Use your connected YouTube @handle or a specific live video in chat Settings.");
      const owner = await this._json(grant, `https://www.googleapis.com/youtube/v3/channels?${params}`);
      if (!owner.items?.some((/** @type {any} */ row) => row.id === grant.platformUserId)) throw this._mismatch("YouTube");
    }
    const params = new URLSearchParams({ part: "id,snippet,status", broadcastType: "all", maxResults: "50" });
    if (normalized.videoId) params.set("id", normalized.videoId);
    else params.set("broadcastStatus", "active");
    const response = await this._json(grant, `https://www.googleapis.com/youtube/v3/liveBroadcasts?${params}`);
    if (response.nextPageToken) throw new PlatformChatError(409, "chat_too_many_broadcasts", "Choose a specific live YouTube video in chat Settings.");
    const chats = new Set();
    for (const row of Array.isArray(response.items) ? response.items : []) {
      if (row.snippet?.channelId !== grant.platformUserId || row.status?.lifeCycleStatus !== "live"
        || normalized.videoId && row.id !== normalized.videoId || !row.snippet?.liveChatId) continue;
      chats.add(String(row.snippet.liveChatId));
    }
    if (!chats.size) throw new PlatformChatError(409, "chat_not_live", "No active chat was found for your connected YouTube channel and saved chat destination.");
    if (chats.size > 10) throw new PlatformChatError(409, "chat_too_many_broadcasts", "Choose a specific live YouTube video in chat Settings.");
    return [...chats];
  }

  /** @param {Platform} platform @param {ChatGrant} grant @param {string} destination @param {string} text */
  async _sendOne(platform, grant, destination, text) {
    const url = platform === "twitch" ? "https://api.twitch.tv/helix/chat/messages"
      : platform === "kick" ? "https://api.kick.com/public/v1/chat"
        : "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet";
    const body = platform === "twitch" ? { broadcaster_id: destination, sender_id: grant.platformUserId, message: text }
      : platform === "kick" ? { broadcaster_user_id: Number(destination), type: "user", content: text }
        : { snippet: { liveChatId: destination, type: "textMessageEvent", textMessageDetails: { messageText: text } } };
    if (platform === "kick" && !Number.isSafeInteger(Number(destination))) throw this._mismatch("Kick");
    let response;
    try {
      response = await this._json(grant, url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json",
        ...(platform === "twitch" ? { "Client-Id": this.integrations.config.twitch.clientId } : {}) } });
    } catch (error) {
      const status = Number(/** @type {any} */ (error)?.status);
      if (status >= 400 && status < 500) {
        if (status === 401 || status === 429) throw safeChatError(error, platform);
        throw new PlatformChatError(status, "chat_message_rejected", `${LABEL[platform]} rejected this message. Check its chat settings before retrying.`);
      }
      throw new PlatformChatError(502, "chat_send_unconfirmed", `${LABEL[platform]} did not confirm this message. Check its chat before sending again.`, true);
    }
    const receipt = platform === "twitch" ? response.data?.[0] : platform === "kick" ? response.data : response;
    if (platform === "youtube" ? !receipt?.id : typeof receipt?.is_sent !== "boolean") {
      throw new PlatformChatError(502, "chat_send_unconfirmed", `${LABEL[platform]} did not confirm this message. Check its chat before sending again.`, true);
    }
    if (platform !== "youtube" && receipt.is_sent !== true) {
      throw new PlatformChatError(502, "chat_message_rejected", `${LABEL[platform]} did not accept this message. Check its chat settings before retrying.`);
    }
  }

  /** @param {ChatGrant} grant @param {string} url @param {RequestInit} [init] */
  _json(grant, url, init = {}) {
    return fetchJson(grant.boundedFetch, url, { ...init,
      headers: { ...init.headers, Authorization: `Bearer ${grant.accessToken}` } }, "platform_chat_request");
  }

  /** @param {string} label */
  _mismatch(label) { return new PlatformChatError(409, "chat_channel_mismatch", `The saved ${label} chat must match your connected account. Update chat Settings or connect the matching account.`); }
}

module.exports = { PlatformChatService, PlatformChatError, validateChatText, MAX_LENGTH };
