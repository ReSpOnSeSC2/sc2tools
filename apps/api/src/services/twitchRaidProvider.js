"use strict";

const { TwitchAutomationProviderError } = require("./twitchAutomationProvider");

/** @typedef {Parameters<import('./twitchAutomationProvider').TwitchAutomationProvider['request']>[0]} Grant */
/** @param {unknown} value @returns {value is string} */
const twitchUserId = value => typeof value === "string" && /^[1-9][0-9]{0,29}$/.test(value);

/**
 * Twitch's raid calls (`POST` and `DELETE helix/raids`, scope
 * `channel:manage:raids`) over the shared bounded Helix transport. Both take
 * their ids as query parameters. A 200 only means Twitch queued the raid.
 */
class TwitchRaidProvider {
  /** @param {import('./twitchAutomationProvider').TwitchAutomationProvider} transport */
  constructor(transport) { this.transport = transport; }

  /**
   * Queue a raid; Twitch then counts down 90 seconds. An answer that is not
   * the documented receipt is reported as unconfirmed so the caller never
   * sends the same raid twice.
   *
   * @param {Grant} grant @param {string} toBroadcasterId
   */
  async start(grant, toBroadcasterId) {
    if (!twitchUserId(toBroadcasterId) || toBroadcasterId === grant.platformUserId) {
      throw new TwitchAutomationProviderError("twitch_raid_target_invalid", 400, false);
    }
    const query = new URLSearchParams({ from_broadcaster_id: grant.platformUserId, to_broadcaster_id: toBroadcasterId });
    const reply = /** @type {{ data?: Array<{ created_at?: unknown }> } | null} */ (await this.transport.request(grant, `raids?${query}`, "POST"));
    const row = Array.isArray(reply?.data) && reply.data.length === 1 ? reply.data[0] : null;
    if (!row || typeof row.created_at !== "string") throw new TwitchAutomationProviderError("twitch_raid_receipt_incomplete", 502, true);
    return { createdAt: row.created_at };
  }

  /** Cancel the streamer's pending raid; Twitch answers 204 with no body.
   * @param {Grant} grant */
  async cancel(grant) {
    await this.transport.request(grant, `raids?${new URLSearchParams({ broadcaster_id: grant.platformUserId })}`, "DELETE");
  }
}

module.exports = { TwitchRaidProvider };
