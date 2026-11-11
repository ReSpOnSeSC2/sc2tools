"use strict";

const { sha256 } = require("../util/hash");
const { clip } = require("./twitchAutomationPolicy");

const ACTIONS = ["randomizer", "buildVote", "pin", "recap", "broll", "tts"];
const SETTLEMENT = ["none", "fulfill", "refund", "both"];
const SUBSCRIPTION = "channel.channel_points_custom_reward_redemption.add";
const MAX_MAPPINGS = 20;
const MAX_INPUT = 200;
const PENDING_MS = 2 * 60_000;
const NEXT_GAME_MS = 30 * 60_000;
const KEEP_MS = 7 * 24 * 60 * 60_000;

/** @param {unknown} value @returns {value is string} */
const id = value => typeof value === "string" && /^[a-z0-9_-]{1,128}$/i.test(value);
/** @param {unknown} value @returns {value is string} */
const twitchUserId = value => typeof value === "string" && /^[1-9][0-9]{0,29}$/.test(value);
/** @param {unknown} value @returns {Record<string,any>} */
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
/** @param {string} code @param {number} status @param {string} [message] */
const rewardError = (code, status, message) => Object.assign(new Error(message || code), { code, status });
/** @param {string} token */
const targetId = token => sha256(`twitch-reward-overlay:${token}`);
/** @param {string} text @param {number} max */
const safeText = (text, max) => clip(text.replace(/[\p{Cf}]/gu, " "), max);

/** Validate the signed body separately from the chat-alert presentation shape.
 * @param {Record<string,any>} payload @param {{messageType?:string,subscriptionType?:string}} headers @param {string} broadcasterId @param {number} now */
function signedRedemption(payload, headers, broadcasterId, now) {
  const subscription = object(payload.subscription), event = object(payload.event), reward = object(event.reward);
  if (headers.messageType !== "notification" || subscription.type !== SUBSCRIPTION || subscription.version !== "1" || subscription.status !== "enabled"
    || headers.subscriptionType && headers.subscriptionType !== SUBSCRIPTION
    || !twitchUserId(broadcasterId) || subscription.condition?.broadcaster_user_id !== broadcasterId || event.broadcaster_user_id !== broadcasterId
    || !id(event.id) || !id(reward.id) || !twitchUserId(event.user_id) || !["unfulfilled", "fulfilled"].includes(event.status)) return null;
  const at = typeof event.redeemed_at === "string" ? Date.parse(event.redeemed_at) : NaN;
  if (!Number.isFinite(at) || now - at > PENDING_MS || at - now > 5000) return null;
  return { redemptionId: event.id, broadcasterId, rewardId: reward.id, viewerId: event.user_id, providerStatus: String(event.status),
    rewardTitle: safeText(typeof reward.title === "string" ? reward.title : "", 45),
    name: safeText(typeof event.user_name === "string" ? event.user_name : "", 60),
    login: safeText(typeof event.user_login === "string" ? event.user_login : "", 60),
    input: safeText(typeof event.user_input === "string" ? event.user_input : "", MAX_INPUT) };
}

/** @param {unknown} raw @param {boolean} [strict] */
function rewardSettings(raw, strict = false) {
  const source = object(raw);
  if (strict && (typeof source.enabled !== "boolean" || !Array.isArray(source.mappings) || source.mappings.length > MAX_MAPPINGS
    || Object.keys(source).some(key => !["enabled", "target", "mappings"].includes(key)))) {
    throw rewardError("reward_settings_invalid", 400, "Save a target, an on/off choice, and up to 20 reward mappings.");
  }
  const target = typeof source.target === "string" && /^[a-f0-9]{64}$/.test(source.target) ? source.target : null;
  const seen = new Set();
  const mappings = (Array.isArray(source.mappings) ? source.mappings.slice(0, MAX_MAPPINGS) : []).flatMap(rawMapping => {
    const mapping = object(rawMapping);
    const buildIds = Array.isArray(mapping.buildIds) ? mapping.buildIds.filter(id) : [];
    if (!id(mapping.rewardId) || !ACTIONS.includes(mapping.action) || seen.has(mapping.rewardId)
      || typeof mapping.enabled !== "boolean" || !SETTLEMENT.includes(mapping.settlement)
      || !Number.isSafeInteger(mapping.cooldownSec) || mapping.cooldownSec < 5 || mapping.cooldownSec > 3600
      || mapping.action === "buildVote" && (buildIds.length < 2 || buildIds.length > 3 || new Set(buildIds).size !== buildIds.length)
      || strict && (Object.keys(mapping).some(key => !["rewardId", "action", "enabled", "cooldownSec", "settlement", "buildIds"].includes(key))
        || mapping.buildIds !== undefined && (!Array.isArray(mapping.buildIds) || mapping.buildIds.length !== buildIds.length))) {
      if (strict) throw rewardError("reward_mapping_invalid", 400, "Use a different Twitch reward per row, a supported action, and a cooldown from 5 to 3,600 seconds. A build vote needs two or three different builds.");
      return [];
    }
    seen.add(mapping.rewardId);
    return [{ rewardId: String(mapping.rewardId), action: String(mapping.action), enabled: mapping.enabled === true,
      cooldownSec: Number(mapping.cooldownSec), settlement: String(mapping.settlement), buildIds: mapping.action === "buildVote" ? /** @type {string[]} */ (buildIds) : [] }];
  });
  if (strict && source.enabled && (!target || !mappings.some(mapping => mapping.enabled))) throw rewardError("reward_target_required", 400, "Choose an overlay and map a reward before turning reward actions on.");
  return { enabled: source.enabled === true && Boolean(target), target, mappings,
    revision: id(source.revision) ? source.revision : null,
    broadcasterId: twitchUserId(source.broadcasterId) ? source.broadcasterId : null };
}

module.exports = { object, ACTIONS, SETTLEMENT, MAX_MAPPINGS, PENDING_MS, NEXT_GAME_MS, KEEP_MS, rewardError, id, twitchUserId, targetId, safeText, signedRedemption, rewardSettings };
