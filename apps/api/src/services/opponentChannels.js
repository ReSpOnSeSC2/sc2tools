"use strict";
const { normalizeIdentity } = require("./playerChannels");

/** Match-local, bounded directory reads. No seed writes, alias expansion,
 * name matching, or external provider requests occur on this path. */
class OpponentChannelsCache {
  /** @param {import('./playerChannels').PlayerChannelsService} directory */
  constructor(directory) { this.directory = directory; this.cache = new Map(); }

  /** @param {string} userId @param {Record<string,any>} envelope */
  async forMatch(userId, envelope) {
    if (!envelope || envelope.isReplay || !["match_loading", "match_started", "match_in_progress"].includes(envelope.phase)) return {};
    const key = typeof envelope.gameKey === "string" ? envelope.gameKey : "";
    if (!key || key.length > 120) return {};
    let identity;
    const profile = envelope.opponent?.profile;
    const pulseCharacterId = profile?.confidence !== undefined && profile.confidence !== 1 ? null : profile?.pulse_character_id;
    try { identity = normalizeIdentity({ pulseCharacterId, toonHandle: envelope.opponent?.toonHandle }); } catch { return {}; }
    const cacheKey = JSON.stringify([userId, key, identity]);
    const revision = this.directory.liveRevision;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.revision === revision && hit.expiresAt > Date.now()) return hit.promise;
    while (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value);
    const promise = this.directory.resolveApprovedExact(identity)
      .then(value => this.directory.liveRevision === revision ? value : {})
      .catch(() => { if (this.cache.get(cacheKey)?.promise === promise) this.cache.delete(cacheKey); return {}; });
    this.cache.set(cacheKey, { revision, expiresAt: Date.now() + 5 * 60_000, promise });
    return promise;
  }
}

/** @param {Record<string,string>} channels @returns {string|null} */
function shoutoutText(channels) {
  const urls = [channels.twitch, channels.youtube].filter(Boolean);
  return urls.length ? `Check out our opponent's stream: ${urls.join(" · ")}` : null;
}

module.exports = { OpponentChannelsCache, shoutoutText };
