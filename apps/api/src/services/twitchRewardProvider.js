"use strict";

const { id, rewardError, safeText } = require("./twitchRewardPolicy");

/** @typedef {Parameters<import('./twitchAutomationProvider').TwitchAutomationProvider['request']>[0]} Grant */
/** @param {Grant} grant @param {Record<string,string>} [query] */
const queryFor = (grant, query) => new URLSearchParams({ broadcaster_id: grant.platformUserId, ...query }).toString();

class TwitchRewardProvider {
  /** @param {import('./twitchAutomationProvider').TwitchAutomationProvider} transport */
  constructor(transport) { this.transport = transport; }
  /** @param {Grant} grant */
  isLive(grant) { return this.transport.isLive(grant); }

  /** @param {Grant} grant @param {Record<string,string>} [query] */
  async readRewards(grant, query) {
    const reply = await this.transport.request(grant, `channel_points/custom_rewards?${queryFor(grant, query)}`, "GET", undefined, 192 * 1024);
    if (!Array.isArray(reply?.data) || reply.data.length > 50 || reply.data.some((/** @type {any} */ row) => row.broadcaster_id !== grant.platformUserId || !id(row.id))) {
      throw rewardError("twitch_rewards_unverified", 502, "Twitch did not confirm the reward list.");
    }
    return /** @type {any[]} */ (reply.data);
  }

  /** @param {Grant} grant */
  async list(grant) {
    const rows = await this.readRewards(grant);
    const manageable = new Set((await this.readRewards(grant, { only_manageable_rewards: "true" })).map(row => row.id));
    return rows.map(row => ({ id: String(row.id), title: safeText(String(row.title || "Twitch reward"), 45),
      enabled: row.is_enabled === true, manageable: manageable.has(row.id), autoSkipsQueue: row.should_redemptions_skip_request_queue === true }));
  }

  /** A reward created by this client can opt into settlement. The owner
   * explicitly creates it, and can edit or disable it later on Twitch.
   * @param {Grant} grant @param {{title:string,cost:number,requiresInput:boolean}} input */
  async create(grant, input) {
    const reply = await this.transport.request(grant, `channel_points/custom_rewards?${queryFor(grant)}`, "POST", {
      title: input.title, cost: input.cost, is_user_input_required: input.requiresInput, is_enabled: false,
      should_redemptions_skip_request_queue: false,
    });
    const row = Array.isArray(reply?.data) && reply.data.length === 1 ? reply.data[0] : null;
    if (!row || !id(row.id) || row.broadcaster_id !== grant.platformUserId || row.title !== input.title || row.cost !== input.cost
      || row.is_enabled !== false || row.should_redemptions_skip_request_queue !== false) {
      throw rewardError("twitch_reward_create_unconfirmed", 502, "Check the Twitch rewards list before creating this reward again.");
    }
    return { id: String(row.id), title: safeText(input.title, 45), enabled: false, manageable: true, autoSkipsQueue: false };
  }

  /** @param {Grant} grant @param {string} rewardId @param {string} redemptionId @param {'FULFILLED'|'CANCELED'} status */
  async settle(grant, rewardId, redemptionId, status) {
    // Existing dashboard-created rewards may run an action. Only a reward
    // created by this Client-Id and still awaiting settlement can be patched.
    const manageable = await this.readRewards(grant, { only_manageable_rewards: "true" });
    if (!manageable.some(row => row.id === rewardId && row.should_redemptions_skip_request_queue !== true)) return "unmanaged";
    const query = queryFor(grant, { reward_id: rewardId, id: redemptionId });
    const path = `channel_points/custom_rewards/redemptions?${query}`;
    const current = await this.transport.request(grant, path, "GET");
    if (matches(current, grant, rewardId, redemptionId, "FULFILLED") || matches(current, grant, rewardId, redemptionId, "CANCELED")) return "already_settled";
    if (!matches(current, grant, rewardId, redemptionId, "UNFULFILLED")) return "unconfirmed";
    const result = await this.transport.request(grant, path, "PATCH", { status });
    if (!matches(result, grant, rewardId, redemptionId, status)) return "unconfirmed";
    return status === "FULFILLED" ? "fulfilled" : "refunded";
  }
}

/** @param {any} reply @param {Grant} grant @param {string} rewardId @param {string} redemptionId @param {string} status */
function matches(reply, grant, rewardId, redemptionId, status) {
  const row = Array.isArray(reply?.data) && reply.data.length === 1 ? reply.data[0] : null;
  return Boolean(row && row.id === redemptionId && row.reward?.id === rewardId && row.broadcaster_id === grant.platformUserId && row.status === status);
}

module.exports = { TwitchRewardProvider };
