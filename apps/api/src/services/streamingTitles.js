"use strict";

const { PlatformIntegrationError } = require("./platformIntegrations");
const { STREAMING_SCOPES } = require("./platformOauthClients");
const { fetchJson, fetchNoContent } = require("./platformOauthHttp");

const TITLE_PLATFORMS = Object.freeze(["twitch", "kick"]);
const KICK_VERIFICATION_DELAYS_MS = Object.freeze([350, 900]);
/** @typedef {'twitch'|'kick'} TitlePlatform */
/** @typedef {{accessToken:string,platformUserId:string,platformUserName:string,
 * boundedFetch:typeof fetch,assertCurrent:()=>Promise<void>}} TitleGrant */
/** @typedef {{title:string,isLive:boolean|null}} TitleObservation */
/** @typedef {{account:{platformUserId:string,account:string}|null,
 * observed:TitleObservation|null,accepted:boolean,updated:boolean}} TitleOutcome */

/** Title transport failures do not revoke an already verified account grant.
 * A rejected write can also be a provider policy rejection, rather than OAuth.
 * @param {unknown} error
 */
function unusableGrant(error) {
  const detail = /** @type {any} */ (error);
  return connectionInvalid(error) || ["streaming_connection_changed", "streaming_coordination_unavailable",
    "streaming_account_busy", "streaming_endpoint_invalid"].includes(detail?.code);
}

/** Only affirmative authorization/identity loss tells a consumer to reconnect.
 * Busy coordination or an expired lease does not revoke an existing grant.
 * @param {unknown} error */
function connectionInvalid(error) {
  const detail = /** @type {any} */ (error);
  return ["streaming_consent_required", "streaming_scopes_missing", "streaming_client_mismatch",
    "streaming_identity_mismatch", "streaming_reconnect_required"].includes(detail?.code)
    || detail?.status === 401 || detail?.status === 403 && detail?.code !== "stream_title_update";
}

/** @param {TitlePlatform} platform @param {TitleObservation} observed */
function offlineTitleUnavailable(platform, observed) {
  return platform === "kick" && observed.isLive === false && observed.title === "";
}

/** Return only safe observations, never provider payloads, URLs or credentials.
 * @param {TitlePlatform} platform @param {string} title @param {TitleOutcome} outcome @param {unknown} error */
function titleFailureResult(platform, title, outcome, error) {
  const ready = outcome.account !== null && !unusableGrant(error);
  const rejected = /** @type {any} */ (error)?.code === "stream_title_update"
    && [400, 403, 404, 422, 429].includes(/** @type {any} */ (error)?.status);
  return { platform, connected: ready, streamingReady: ready, connectionInvalid: connectionInvalid(error),
    ...(ready ? outcome.account : {}), title: ready ? outcome.observed?.title ?? null : null,
    requestedTitle: title, observedTitle: ready ? outcome.observed?.title ?? null : null,
    isLive: ready ? outcome.observed?.isLive ?? null : null,
    accepted: ready && outcome.accepted, updated: ready && outcome.updated, titleVerified: false,
    titleStatus: ready && outcome.accepted ? "pending" : rejected ? "rejected" : "unverified",
    reason: ready && outcome.accepted
      ? "The platform accepted the title request, but its current title could not be confirmed. Check status before retrying."
      : ready && rejected ? "The platform rejected this title request. Your account is still connected."
        : safeStreamingReason(error) };
}

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
  /** @param {{integrations:import('./platformIntegrations').PlatformIntegrationsService,
   * wait?:(milliseconds:number)=>Promise<void>}} deps */
  constructor({ integrations, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }) {
    this.integrations = integrations;
    this.wait = wait;
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
        streamingReady: Boolean(permitted), connectionInvalid: false, title: null, isLive: null,
        titleStatus: "unavailable", titleVerified: false,
        platformUserId: String(row.platformUserId || ""), account: String(row.platformUserName || ""),
        reason: permitted ? "" : leaseAvailable
          ? "Connect this account's stream controls on SC2Tools and approve its permissions."
          : "Stream control is unavailable until server coordination is ready." };
      if (!permitted || !TITLE_PLATFORMS.includes(row.platform)) return base;
      let grantVerified = false;
      try {
        const observed = await this.integrations.withStreamingGrant(userId, row.platform, (grant) => {
          grantVerified = true;
          return this._readTitle(/** @type {TitlePlatform} */ (row.platform), grant);
        });
        const unavailable = offlineTitleUnavailable(/** @type {TitlePlatform} */ (row.platform), observed);
        return { ...base, ...observed, titleVerified: !unavailable,
          titleStatus: unavailable ? "unavailable_offline" : "observed",
          reason: unavailable ? "Kick's offline readback does not expose the saved title." : "" };
      } catch (error) {
        return { ...base, streamingReady: grantVerified && !unusableGrant(error),
          connectionInvalid: connectionInvalid(error), reason: safeStreamingReason(error) };
      }
    }));
    return { platforms };
  }

  /** `accepted` records a successful provider receipt, not readback evidence.
   * `titleVerified`/`titleStatus` distinguish confirmation from offline/pending
   * reads. Only accepted_offline substitutes requestedTitle into `title`;
   * pending uses observedTitle. `updated` means a PATCH succeeded.
   * @param {string} userId @param {unknown} value @param {unknown} [platforms] */
  async updateTitle(userId, value, platforms = TITLE_PLATFORMS) {
    const title = validateSharedTitle(value);
    if (!Array.isArray(platforms) || !platforms.length || platforms.length > 2
      || new Set(platforms).size !== platforms.length
      || platforms.some((name) => !TITLE_PLATFORMS.includes(name))) {
      throw new PlatformIntegrationError(400, "stream_title_platforms_invalid", "Choose Twitch or Kick for this title operation.");
    }
    const results = await Promise.all(platforms.map(async (platform) => {
      /** @type {TitleOutcome} */
      const outcome = { account: null, observed: null, accepted: false, updated: false };
      try {
        return await this.integrations.withStreamingGrant(userId, platform, async (grant) => {
          outcome.account = { platformUserId: grant.platformUserId, account: grant.platformUserName };
          const previous = await this._readTitle(platform, grant);
          outcome.observed = previous;
          if (previous.title !== title) {
            await this._patchTitle(platform, grant, title);
            outcome.updated = true;
          }
          outcome.accepted = true;
          // Kick can return blank metadata offline and stale metadata online.
          // Retry only safe reads; a successful PATCH is never replayed.
          outcome.observed = null;
          const observed = await this._verifyTitle(platform, grant, title);
          outcome.observed = observed;
          const titleVerified = observed.title === title;
          const offline = !titleVerified && offlineTitleUnavailable(platform, observed);
          return { platform, connected: true, streamingReady: true, connectionInvalid: false, ...outcome.account,
            title: titleVerified || offline ? title : observed.title,
            requestedTitle: title, observedTitle: observed.title, isLive: observed.isLive,
            accepted: outcome.accepted, updated: outcome.updated, titleVerified,
            titleStatus: titleVerified ? "verified" : offline ? "accepted_offline" : "pending",
            reason: titleVerified ? "" : offline
              ? "Kick accepted this title, but its offline readback is empty. Confirm it in the Creator Dashboard or once live."
              : "The platform accepted the title request; its current title does not match yet. Check status before retrying." };
        });
      } catch (error) {
        return titleFailureResult(platform, title, outcome, error);
      }
    }));
    return { platforms: results };
  }

  /** @param {TitlePlatform} platform @param {TitleGrant} grant @param {string} title */
  async _patchTitle(platform, grant, title) {
    await grant.assertCurrent();
    const url = platform === "twitch"
      ? `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(grant.platformUserId)}`
      : "https://api.kick.com/public/v1/channels";
    const updateFetch = /** @type {typeof fetch} */ (async (target, init) => {
      const response = await grant.boundedFetch(target, init);
      // Kick's documented write receipt is 204. An unexpected success shape
      // cannot establish whether a title update was accepted.
      if (platform === "kick" && response.ok && response.status !== 204) {
        throw new PlatformIntegrationError(502, "stream_title_update_ambiguous", "The title response was not the expected update receipt.");
      }
      return response;
    });
    try {
      await fetchNoContent(updateFetch, url, { method: "PATCH",
        headers: { ...this._headers(platform, grant), "Content-Type": "application/json" },
        body: JSON.stringify(platform === "twitch" ? { title } : { stream_title: title }),
      }, "stream_title_update");
    } catch (error) {
      // HTTP helpers sanitize request errors; preserve an underlying expired
      // lease/connection before treating the error as a title-only failure.
      await grant.assertCurrent();
      throw error;
    }
  }

  /** @param {TitlePlatform} platform @param {TitleGrant} grant @param {string} title
   * @returns {Promise<TitleObservation>} */
  async _verifyTitle(platform, grant, title) {
    let observed = await this._readTitle(platform, grant);
    if (platform !== "kick") return observed;
    for (const milliseconds of KICK_VERIFICATION_DELAYS_MS) {
      if (observed.title === title || observed.isLive === false) break;
      await this.wait(milliseconds);
      await grant.assertCurrent();
      observed = await this._readTitle(platform, grant);
    }
    return observed;
  }

  /** @param {TitlePlatform} platform @param {TitleGrant} grant */
  _headers(platform, grant) {
    return { Authorization: `Bearer ${grant.accessToken}`,
      ...(platform === "twitch" ? { "Client-Id": this.integrations.config.twitch.clientId } : {}) };
  }

  /** @param {TitlePlatform} platform @param {TitleGrant} grant
   * @returns {Promise<TitleObservation>} */
  async _readTitle(platform, grant) {
    const url = platform === "twitch"
      ? `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(grant.platformUserId)}`
      : "https://api.kick.com/public/v1/channels";
    await grant.assertCurrent();
    let result;
    try {
      result = await fetchJson(grant.boundedFetch, url,
        { headers: this._headers(platform, grant) }, "stream_title_read");
    } catch (error) {
      await grant.assertCurrent();
      throw error;
    }
    const rows = result?.data;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const identity = platform === "twitch" ? row?.broadcaster_id : row?.broadcaster_user_id;
    const title = platform === "twitch" ? row?.title : row?.stream_title;
    if (!row || !["string", "number"].includes(typeof identity) || !String(identity)) {
      throw new PlatformIntegrationError(503, "stream_title_observation_unavailable", "The platform did not return a complete owned title observation.");
    }
    if (String(identity) !== grant.platformUserId) {
      throw new PlatformIntegrationError(409, "streaming_identity_mismatch", "The owned platform title could not be verified.");
    }
    if (typeof title !== "string") {
      throw new PlatformIntegrationError(503, "stream_title_observation_unavailable", "The platform did not return a complete title observation.");
    }
    return { title, isLive: platform === "kick" && typeof row.stream?.is_live === "boolean"
      ? row.stream.is_live : null };
  }
}

module.exports = { StreamingTitlesService, validateSharedTitle, safeStreamingReason, TITLE_PLATFORMS };
