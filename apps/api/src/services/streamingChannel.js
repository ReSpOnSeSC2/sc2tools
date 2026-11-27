"use strict";

const { PlatformIntegrationError } = require("./platformIntegrations");
const { fetchJson, fetchNoContent } = require("./platformOauthHttp");
const { safeStreamingReason } = require("./streamingTitles");

const CHANNEL_PLATFORMS = Object.freeze(["twitch", "kick"]);
const MAX_TAGS = 10;
/** One rule for both providers: Twitch allows letters and digits only, up to
 * 25 characters, and Kick's documented limit is the count, so the stricter
 * Twitch rule keeps every tag valid on either platform. */
const TAG_PATTERN = /^[A-Za-z0-9]{1,25}$/;
/** Twitch's catalogue id for StarCraft II; stable for the life of the game. */
const TWITCH_STARCRAFT_ID = "490422";
const KICK_CATEGORY_NAME = "StarCraft II";
const TWITCH_CHANNELS = "https://api.twitch.tv/helix/channels";
const KICK_CHANNELS = "https://api.kick.com/public/v1/channels";
const KICK_CATEGORIES = "https://api.kick.com/public/v2/categories";

/** @typedef {{accessToken:string,platformUserId:string,platformUserName:string,
 * boundedFetch:typeof fetch,assertCurrent:()=>Promise<void>}} ChannelGrant */
/** @typedef {{tags:string[]|null,categoryId:string}} ChannelObservation */

/** @param {unknown} value @param {string} code */
function validateTagList(value, code) {
  if (!Array.isArray(value) || value.length > MAX_TAGS
    || value.some((tag) => typeof tag !== "string" || !TAG_PATTERN.test(tag))) {
    throw new PlatformIntegrationError(400, code,
      "Use up to 10 tags of letters and digits, 25 characters at most each.");
  }
  return /** @type {string[]} */ (value);
}

/** @param {unknown} value */
function validatePlatform(value) {
  if (typeof value !== "string" || !CHANNEL_PLATFORMS.includes(value)) {
    throw new PlatformIntegrationError(400, "stream_channel_platform_invalid", "Choose Twitch or Kick.");
  }
  return /** @type {'twitch'|'kick'} */ (value);
}

/** Tags the streamer set by hand stay; ours fill the places that remain.
 * Tags we wrote last time are the only ones that may be replaced.
 * @param {string[]} current @param {string[]} previous @param {string[]} ours */
function mergeTags(current, previous, ours) {
  const lower = (/** @type {string} */ tag) => tag.toLowerCase();
  const replaceable = new Set(previous.map(lower));
  const kept = current.filter((tag) => !replaceable.has(lower(tag)));
  const taken = new Set(kept.map(lower));
  const added = [];
  for (const tag of ours) {
    if (kept.length + added.length >= MAX_TAGS) break;
    if (!taken.has(lower(tag))) { taken.add(lower(tag)); added.push(tag); }
  }
  return { merged: [...kept, ...added], added };
}

/** @param {string[]} left @param {string[]} right */
const sameTags = (left, right) => left.length === right.length
  && left.every((tag, index) => tag.toLowerCase() === right[index].toLowerCase());

/** Channel tags and the StarCraft II category guard. Each call is one small
 * read then at most one write; a failure is reported as a receipt and never
 * thrown, so it cannot hold up the title update that runs beside it. */
class StreamingChannelService {
  /** @param {{integrations:import('./platformIntegrations').PlatformIntegrationsService}} deps */
  constructor({ integrations }) {
    this.integrations = integrations;
    /** @type {string|null} */
    this.kickCategoryId = null;
  }

  /** @param {string} userId @param {unknown} platform @param {unknown} tags @param {unknown} previous */
  async setTags(userId, platform, tags, previous) {
    const name = validatePlatform(platform);
    const ours = validateTagList(tags, "stream_tags_invalid");
    const earlier = validateTagList(previous, "stream_tags_invalid");
    return this._run(userId, name, async (grant) => {
      const observed = await this._read(name, grant);
      if (observed.tags === null) {
        return { status: "skipped", reason: "Kick shows your tags only while you are live." };
      }
      const { merged, added } = mergeTags(observed.tags, earlier, ours);
      if (sameTags(merged, observed.tags)) return { status: "unchanged", tags: merged, added };
      await this._patch(name, grant, name === "twitch" ? { tags: merged } : { custom_tags: merged });
      return { status: "updated", tags: merged, added };
    });
  }

  /** Switch to StarCraft II only when the channel sits under another category.
   * @param {string} userId @param {unknown} platform */
  async ensureCategory(userId, platform) {
    const name = validatePlatform(platform);
    return this._run(userId, name, async (grant) => {
      const observed = await this._read(name, grant);
      const target = name === "twitch" ? TWITCH_STARCRAFT_ID : await this._kickCategory(grant);
      if (observed.categoryId === target) return { status: "unchanged" };
      await this._patch(name, grant, name === "twitch" ? { game_id: target } : { category_id: Number(target) });
      return { status: "updated" };
    });
  }

  /** @param {string} userId @param {'twitch'|'kick'} platform
   * @param {(grant:ChannelGrant)=>Promise<Record<string, unknown>>} work */
  async _run(userId, platform, work) {
    try {
      const result = await this.integrations.withStreamingGrant(userId, platform, work);
      return { platform, ok: true, ...result };
    } catch (error) {
      return { platform, ok: false, status: "failed", reason: safeStreamingReason(error) };
    }
  }

  /** @param {'twitch'|'kick'} platform @param {ChannelGrant} grant */
  _headers(platform, grant) {
    return { Authorization: `Bearer ${grant.accessToken}`,
      ...(platform === "twitch" ? { "Client-Id": this.integrations.config.twitch.clientId } : {}) };
  }

  /** @param {'twitch'|'kick'} platform @param {ChannelGrant} grant
   * @returns {Promise<ChannelObservation>} */
  async _read(platform, grant) {
    await grant.assertCurrent();
    const url = platform === "twitch"
      ? `${TWITCH_CHANNELS}?broadcaster_id=${encodeURIComponent(grant.platformUserId)}` : KICK_CHANNELS;
    const result = await fetchJson(grant.boundedFetch, url,
      { headers: this._headers(platform, grant) }, "stream_channel_read");
    const rows = result?.data;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const identity = platform === "twitch" ? row?.broadcaster_id : row?.broadcaster_user_id;
    if (!row || String(identity ?? "") !== grant.platformUserId) {
      throw new PlatformIntegrationError(409, "streaming_identity_mismatch", "The owned platform channel could not be verified.");
    }
    if (platform === "twitch") {
      return { tags: Array.isArray(row.tags) ? row.tags.map(String) : [], categoryId: String(row.game_id ?? "") };
    }
    const live = row.stream?.is_live === true && Array.isArray(row.stream.custom_tags);
    return { tags: live ? row.stream.custom_tags.map(String) : null, categoryId: String(row.category?.id ?? "") };
  }

  /** @param {'twitch'|'kick'} platform @param {ChannelGrant} grant @param {Record<string, unknown>} body */
  async _patch(platform, grant, body) {
    await grant.assertCurrent();
    const url = platform === "twitch"
      ? `${TWITCH_CHANNELS}?broadcaster_id=${encodeURIComponent(grant.platformUserId)}` : KICK_CHANNELS;
    await fetchNoContent(grant.boundedFetch, url, { method: "PATCH",
      headers: { ...this._headers(platform, grant), "Content-Type": "application/json" },
      body: JSON.stringify(body) }, "stream_channel_update");
  }

  /** @param {ChannelGrant} grant */
  async _kickCategory(grant) {
    if (this.kickCategoryId) return this.kickCategoryId;
    await grant.assertCurrent();
    const result = await fetchJson(grant.boundedFetch,
      `${KICK_CATEGORIES}?name=${encodeURIComponent(KICK_CATEGORY_NAME)}`,
      { headers: this._headers("kick", grant) }, "stream_category_lookup");
    const match = (Array.isArray(result?.data) ? result.data : [])
      .find((/** @type {any} */ row) => String(row?.name).toLowerCase() === KICK_CATEGORY_NAME.toLowerCase());
    if (!Number.isInteger(match?.id) || match.id < 1) {
      throw new PlatformIntegrationError(503, "stream_category_unavailable", "The StarCraft II category could not be found.");
    }
    this.kickCategoryId = String(match.id);
    return this.kickCategoryId;
  }
}

module.exports = { StreamingChannelService, mergeTags, TAG_PATTERN, MAX_TAGS };
