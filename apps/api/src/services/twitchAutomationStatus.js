"use strict";
const { receiptStatus } = require("./twitchAutomation");

/** Explicit Settings refresh can verify the channel. Ordinary Dock polling
 * only uses metadata/cached observations and never polls Twitch per widget. */
class TwitchAutomationStatus {
  /** @param {{automation:import('./twitchAutomation').TwitchAutomationService,broker:import('./liveGameBroker').LiveGameBroker,now?:()=>number}} deps */
  constructor({ automation, broker, now = Date.now }) {
    this.automation = automation; this.broker = broker; this.now = now;
    /** @type {Map<string,{revision:string,until:number,eligible:boolean|null,isLive:boolean|null,reason:string|null}>} */ this.channels = new Map();
  }
  /** @param {string} userId @param {boolean} [verify] */
  async get(userId, verify = false) {
    const { integrations, receipts } = this.automation.deps;
    const preferences = await this.automation.preferences(userId);
    const connection = (await integrations.statuses(userId)).platforms.find(row => row.platform === "twitch");
    const gameKey = this.broker.currentGameKey(userId), current = gameKey ? await receipts.read(userId, gameKey) : null;
    const row = await receipts.latestOpen(userId) || current;
    let observed = this.channels.get(userId);
    if (!connection?.connected || !connection.ready) observed = undefined;
    // Status rows intentionally omit the private connection revision. Compare
    // the public provider identity; the callback replaces this with its leased
    // revision and a re-read below cannot reuse a different account's cache.
    const identity = connection?.platformUserId || "";
    if (observed?.revision.split(":")[0] !== identity || observed && observed.until <= this.now()) observed = undefined;
    if (verify && this.automation.deps.enabled === true && connection?.connected && connection.ready && !observed) {
      try {
        observed = await this.automation.admitted(() => this.automation.withOwner(userId, () => integrations.withTwitchAutomationGrant(userId, {}, async grant => ({
          revision: `${grant.platformUserId}:${grant.connectionRevision}`, until: this.now() + 30_000,
          eligible: await this.automation.eligibleBroadcaster(grant), isLive: await this.automation.deps.provider.isLive(grant), reason: null,
        }))));
        if (this.channels.size >= 256) { const oldest = this.channels.keys().next().value; if (oldest) this.channels.delete(oldest); }
        if (observed) this.channels.set(userId, observed);
      } catch (error) {
        const status = /** @type {any} */ (error)?.status;
        observed = { revision: `${identity}:unverified`, until: this.now() + 5000, eligible: null, isLive: null,
          reason: status === 401 || status === 403 ? "reconnect_required" : status === 429 ? "provider_rate_limited" : "channel_unverified" };
      }
    }
    return { preferences, serverEnabled: this.automation.deps.enabled === true, configured: connection?.configured === true, connected: connection?.connected === true,
      predictionPermission: connection?.ready === true && connection.predictionsConsent === true && connection.scopes.includes("channel:manage:predictions"),
      markerPermission: connection?.ready === true && connection.streamingConsent === true && connection.scopes.includes("channel:manage:broadcast"),
      eligible: observed?.eligible ?? null, isLive: observed?.isLive ?? null,
      reason: this.automation.deps.enabled !== true ? "server_not_enabled" : !connection?.connected ? "connect_twitch" : observed?.reason || (observed?.eligible === false ? "affiliate_or_partner_required" : observed?.isLive === false ? "channel_offline" : null),
      rankedQueueSupported: false, capabilityReason: "ranked_status_unavailable",
      current: row ? { gameKey: row.gameKey, ...receiptStatus(row) } : null };
  }
}
module.exports = { TwitchAutomationStatus };
