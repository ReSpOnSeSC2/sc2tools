"use strict";

const { PlatformIntegrationError } = require("./platformIntegrations");
const { STREAMING_SCOPES } = require("./platformOauthClients");
const { fetchJson, fetchNoContent } = require("./platformOauthHttp");

const TITLE_PLATFORMS = Object.freeze(["twitch", "kick"]);
/** @typedef {'twitch'|'kick'} TitlePlatform */
/** @typedef {{accessToken:string,platformUserId:string,platformUserName:string,
 * boundedFetch:typeof fetch,assertCurrent:()=>Promise<void>}} TitleGrant */

/** @param {unknown} value */
function validateSharedTitle(value) {
  if (typeof value !== "string" || /[\p{Cc}\u2028\u2029<>]/u.test(value)) {
    throw new PlatformIntegrationError(400, "stream_title_invalid", "Use a title of 1–70 characters without control characters or angle brackets.");
  }
  const title = value.trim();
  const characters = Array.from(title);
  if (!characters.length || characters.length > 70 || characters.some((c) => {
    const point = c.codePointAt(0);
    return point !== undefined && point >= 0xd800 && point <= 0xdfff;
  })) {
    throw new PlatformIntegrationError(400, "stream_title_invalid", "Use a title of 1–70 valid Unicode characters.");
  }
  return title;
}

/** @param {unknown} error */
function safeStreamingReason(error) {
  const code = /** @type {any} */ (error)?.code;
  if (code === "streaming_account_busy") return "Another operation is using this account. Check status shortly.";
  if (code === "streaming_coordination_unavailable") return "Stream control is unavailable until server coordination is ready.";
  if (["streaming_consent_required", "streaming_scopes_missing", "streaming_client_mismatch", "streaming_identity_mismatch", "streaming_reconnect_required"].includes(code)) {
    return "Connect this account's stream controls on SC2Tools and approve its permissions.";
  }
  if (code === "streaming_connection_changed") return "The connection changed or the operation expired. Check status before retrying.";
  if (code === "stream_title_unverified") return "The title change was not confirmed. Check the current title before retrying.";
  return "The platform operation could not be verified. Check status before retrying.";
}

class StreamingTitlesService {
  /** @param {{integrations:import('./platformIntegrations').PlatformIntegrationsService}} deps */
  constructor({ integrations }) {
    this.integrations = integrations;
  }

  /** @param {string} userId */
  async status(userId) {
    const status = await this.integrations.statuses(userId);
    const leaseAvailable = this.integrations.vault?.supportsStreamingLeases?.() === true;
    const platforms = await Promise.all(status.platforms.map(async (row) => {
      const platform = /** @type {'twitch'|'kick'|'youtube'} */ (row.platform);
      const permitted = row.configured === true && row.connected && row.streamingConsent === true
        && leaseAvailable && STREAMING_SCOPES[platform]?.every((scope) => row.scopes.includes(scope));
      const base = { platform: row.platform, connected: row.connected === true,
        streamingReady: Boolean(permitted), title: null,
        platformUserId: String(row.platformUserId || ""), account: String(row.platformUserName || ""),
        reason: permitted ? "" : leaseAvailable
          ? "Connect this account's stream controls on SC2Tools and approve its permissions."
          : "Stream control is unavailable until server coordination is ready." };
      if (!permitted || !TITLE_PLATFORMS.includes(row.platform)) return base;
      try {
        const title = await this.integrations.withStreamingGrant(userId, row.platform,
          (grant) => this._readTitle(/** @type {TitlePlatform} */ (row.platform), grant));
        return { ...base, title };
      } catch (error) {
        return { ...base, streamingReady: false, reason: safeStreamingReason(error) };
      }
    }));
    return { platforms };
  }

  /** @param {string} userId @param {unknown} value @param {unknown} [platforms] */
  async updateTitle(userId, value, platforms = TITLE_PLATFORMS) {
    const title = validateSharedTitle(value);
    if (!Array.isArray(platforms) || !platforms.length || platforms.length > 2
      || new Set(platforms).size !== platforms.length
      || platforms.some((name) => !TITLE_PLATFORMS.includes(name))) {
      throw new PlatformIntegrationError(400, "stream_title_platforms_invalid", "Choose Twitch or Kick for this title operation.");
    }
    const results = await Promise.all(platforms.map(async (platform) => {
      try {
        return await this.integrations.withStreamingGrant(userId, platform, async (grant) => {
          const previous = await this._readTitle(platform, grant);
          if (previous !== title) {
            await grant.assertCurrent();
            const url = platform === "twitch"
              ? `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(grant.platformUserId)}`
              : "https://api.kick.com/public/v1/channels";
            await fetchNoContent(grant.boundedFetch, url, { method: "PATCH",
              headers: { ...this._headers(platform, grant), "Content-Type": "application/json" },
              body: JSON.stringify(platform === "twitch" ? { title } : { stream_title: title }),
            }, "stream_title_update");
          }
          const observed = await this._readTitle(platform, grant);
          if (observed !== title) {
            throw new PlatformIntegrationError(409, "stream_title_unverified", "The requested title was not confirmed.");
          }
          return { platform, connected: true, streamingReady: true, title: observed,
            platformUserId: grant.platformUserId, account: grant.platformUserName,
            updated: previous !== title, reason: "" };
        });
      } catch (error) {
        // Never return raw provider payloads, URLs, grant objects or tokens.
        return { platform, connected: false, streamingReady: false, title: null,
          updated: false, reason: safeStreamingReason(error) };
      }
    }));
    return { platforms: results };
  }

  /** @param {TitlePlatform} platform @param {TitleGrant} grant */
  _headers(platform, grant) {
    return { Authorization: `Bearer ${grant.accessToken}`,
      ...(platform === "twitch" ? { "Client-Id": this.integrations.config.twitch.clientId } : {}) };
  }

  /** @param {TitlePlatform} platform @param {TitleGrant} grant */
  async _readTitle(platform, grant) {
    const url = platform === "twitch"
      ? `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(grant.platformUserId)}`
      : "https://api.kick.com/public/v1/channels";
    const result = await fetchJson(grant.boundedFetch, url,
      { headers: this._headers(platform, grant) }, "stream_title_read");
    const rows = result?.data;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const identity = platform === "twitch" ? row?.broadcaster_id : row?.broadcaster_user_id;
    const title = platform === "twitch" ? row?.title : row?.stream_title;
    if (!row || String(identity) !== grant.platformUserId || typeof title !== "string") {
      throw new PlatformIntegrationError(409, "streaming_identity_mismatch", "The owned platform title could not be verified.");
    }
    return title;
  }
}

module.exports = { StreamingTitlesService, validateSharedTitle, safeStreamingReason, TITLE_PLATFORMS };
