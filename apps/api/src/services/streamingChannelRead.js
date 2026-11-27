"use strict";

const { PlatformIntegrationError } = require("./platformIntegrations");
const { fetchJson } = require("./platformOauthHttp");

/** @typedef {'twitch'|'kick'} ChannelPlatform */
/** @typedef {{accessToken:string,platformUserId:string,boundedFetch:typeof fetch,
 * assertCurrent:()=>Promise<void>}} OwnedGrant */

/** The one channel endpoint each provider offers for the connected account.
 * @param {ChannelPlatform} platform @param {OwnedGrant} grant */
function channelUrl(platform, grant) {
  return platform === "twitch"
    ? `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(grant.platformUserId)}`
    : "https://api.kick.com/public/v1/channels";
}

/** @param {ChannelPlatform} platform @param {OwnedGrant} grant @param {string} twitchClientId */
function channelHeaders(platform, grant, twitchClientId) {
  return { Authorization: `Bearer ${grant.accessToken}`,
    ...(platform === "twitch" ? { "Client-Id": twitchClientId } : {}) };
}

/** Read the connected account's channel row and prove it is the owned channel.
 * A row the provider does not return is an observation gap, never a reconnect.
 * @param {ChannelPlatform} platform @param {OwnedGrant} grant @param {string} twitchClientId
 * @param {'title'|'channel'} subject
 * @returns {Promise<Record<string, any>>} */
async function readOwnedChannel(platform, grant, twitchClientId, subject) {
  await grant.assertCurrent();
  let result;
  try {
    result = await fetchJson(grant.boundedFetch, channelUrl(platform, grant),
      { headers: channelHeaders(platform, grant, twitchClientId) }, `stream_${subject}_read`);
  } catch (error) {
    await grant.assertCurrent();
    throw error;
  }
  const rows = result?.data;
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  const identity = platform === "twitch" ? row?.broadcaster_id : row?.broadcaster_user_id;
  if (!row || !["string", "number"].includes(typeof identity) || !String(identity)) {
    throw new PlatformIntegrationError(503, `stream_${subject}_observation_unavailable`,
      `The platform did not return a complete owned ${subject} observation.`);
  }
  if (String(identity) !== grant.platformUserId) {
    throw new PlatformIntegrationError(409, "streaming_identity_mismatch", `The owned platform ${subject} could not be verified.`);
  }
  return row;
}

module.exports = { channelUrl, channelHeaders, readOwnedChannel };
