"use strict";

const { randomUUID } = require("crypto");
const { TWITCH_PURPOSE_SCOPE } = require("./twitchPurposes");
const { TwitchAutomationProvider } = require("./twitchAutomationProvider");
const { TwitchRaidProvider } = require("./twitchRaidProvider");
const { clip } = require("./twitchAutomationPolicy");
const {
  HISTORY_LIMIT, raidError, raidSettings, channelKey, sanitizeHistory, livePendingRaid, rankCandidates, raidFailureError,
} = require("./twitchRaidPolicy");

const HISTORY_PATH = "preferences.twitchRaids.history";
const MAX_IN_FLIGHT = 2;

/** Newest first, capped, in one atomic write. @param {RaidEntry} entry */
const prependHistory = entry => ({ $push: { "preferences.twitchRaids.history": { $each: [entry], $position: 0, $slice: HISTORY_LIMIT } } });

/** @typedef {import('./twitchRaidPolicy').RaidEntry} RaidEntry */
/** @typedef {import('./twitchRaidPolicy').OutState} OutState */
/** The part of a user document the raid finder reads and writes. @typedef {{ userId?: string, preferences?: { twitchRaids?: { enabled?: boolean, history?: RaidEntry[] } } }} UserRaidDoc */
/** @typedef {import('./twitchAutomationProvider').Grant} Grant */
/** The fields of a platform connection status the raid finder reads. @typedef {{
 *   platform: string, configured: boolean, connected: boolean, ready: boolean, platformUserId: string,
 *   platformUserName: string, scopes: string[], raidsConsent?: boolean }} ConnectionStatus */
/** @typedef {{ list: () => Promise<import('./liveStreams').LiveStreamsSnapshot> }} LiveList */
/** @typedef {{ users: import('mongodb').Collection<UserRaidDoc>, provider: TwitchRaidProvider, liveStreams: LiveList,
 *   integrations: import('./platformIntegrations').PlatformIntegrationsService, enabled?: boolean, now?: () => number }} Deps */

/**
 * The raid finder: ranks the live StarCraft II channels (read from the cached
 * live list, never from a provider), and starts or cancels a Twitch raid for
 * the streamer. It follows the Twitch automation pattern: its own connect for
 * the raid scope, a server gate that starts off, the streamer's own switch
 * that starts off, a receipt written before the provider is called, and no
 * second POST after an answer that was not confirmed.
 */
class TwitchRaidsService {
  /** @param {Deps} deps */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    /** @type {Set<string>} */
    this.inFlight = new Set();
  }

  /** @param {string} userId */
  async stored(userId) {
    const row = await this.deps.users.findOne({ userId }, { projection: { "preferences.twitchRaids": 1 }, maxTimeMS: 1200 });
    const raw = row?.preferences?.twitchRaids;
    return { settings: raidSettings(raw), history: sanitizeHistory(raw?.history, this.now()) };
  }

  /** @param {string} userId */
  async connection(userId) {
    const rows = /** @type {ConnectionStatus[]} */ ((await this.deps.integrations.statuses(userId)).platforms);
    const twitch = rows.find(row => row.platform === "twitch");
    const kick = rows.find(row => row.platform === "kick");
    return {
      configured: twitch?.configured === true,
      connected: twitch?.connected === true,
      permission: Boolean(twitch?.connected && twitch.ready && twitch.raidsConsent === true && twitch.scopes.includes(TWITCH_PURPOSE_SCOPE.raids)),
      twitchId: twitch?.connected ? twitch.platformUserId : "",
      kickName: kick?.connected ? channelKey(kick.platformUserName) : "",
    };
  }

  /**
   * Why Start raid is not available right now, or null when it is.
   * @param {{ configured: boolean, connected: boolean, permission: boolean }} link @param {boolean} switchedOn
   */
  blocker(link, switchedOn) {
    if (this.deps.enabled !== true) return "server_not_enabled";
    if (!link.configured || !link.connected) return "connect_twitch";
    if (!link.permission) return "raid_permission_required";
    return switchedOn ? null : "switch_off";
  }

  /** The streamer's Settings view: gates, permission and the switch.
   * @param {string} userId */
  async settingsView(userId) {
    const [{ settings }, link] = await Promise.all([this.stored(userId), this.connection(userId)]);
    return { serverEnabled: this.deps.enabled === true, enabled: settings.enabled, connected: link.connected, permission: link.permission,
      reason: this.blocker(link, true) };
  }

  /** @param {string} userId @param {unknown} body */
  async saveSettings(userId, body) {
    const next = raidSettings(body, true);
    if (next.enabled) {
      const link = await this.connection(userId);
      const reason = this.blocker(link, true);
      if (reason) throw raidError("Connect Twitch raids in Settings before switching raids on.", 409, reason);
    }
    await this.deps.users.updateOne({ userId }, { $set: { "preferences.twitchRaids.enabled": next.enabled } });
    return this.settingsView(userId);
  }

  /**
   * What the Stream Dock shows: the ranked channels (always, with links),
   * whether a raid can be started, and the raid history.
   * @param {string} userId
   */
  async dockView(userId) {
    const [{ settings, history }, link, live] = await Promise.all([this.stored(userId), this.connection(userId), this.deps.liveStreams.list()]);
    const now = this.now();
    const pending = livePendingRaid(history, now);
    return {
      serverEnabled: this.deps.enabled === true,
      enabled: settings.enabled,
      permission: link.permission,
      reason: this.blocker(link, settings.enabled),
      platforms: live.platforms,
      fetchedAt: live.fetchedAt,
      candidates: rankCandidates(live.streams, { history, self: { twitchId: link.twitchId, kickName: link.kickName } }),
      pending: pending ? { id: pending.id, channel: pending.channel, at: pending.at } : null,
      history,
    };
  }

  /**
   * Run one provider action for the owner: one at a time per streamer, and a
   * small process-wide cap so a burst cannot pile up Helix calls.
   * @template T @param {string} userId @param {(grant: Grant) => Promise<T>} work
   */
  async withRaidGrant(userId, work) {
    if (this.inFlight.has(userId) || this.inFlight.size >= MAX_IN_FLIGHT) throw raidError("A raid request is already running. Wait for Twitch to answer.", 409, "raid_busy");
    this.inFlight.add(userId);
    try {
      return await this.deps.integrations.withTwitchAutomationGrant(userId, { raids: true }, grant => work(grant));
    } finally { this.inFlight.delete(userId); }
  }

  /** Checks shared by Start and Cancel; returns the stored history.
   * @param {string} userId */
  async requireReady(userId) {
    const [{ settings, history }, link] = await Promise.all([this.stored(userId), this.connection(userId)]);
    const reason = this.blocker(link, settings.enabled);
    if (reason) throw raidError("Raids are not available for this channel yet. Check Settings.", 409, reason);
    return history;
  }

  /**
   * Start a raid on a channel that is in the live list right now. The receipt
   * is written first; whatever Twitch answers is written back. An answer that
   * is missing or unclear leaves the receipt "unconfirmed" and is never sent
   * again.
   * @param {string} userId @param {unknown} streamId
   */
  async start(userId, streamId) {
    const history = await this.requireReady(userId);
    if (livePendingRaid(history, this.now())) throw raidError("A raid is already queued. Cancel it first.", 409, "raid_already_queued");
    const live = await this.deps.liveStreams.list();
    const target = live.streams.find(stream => stream.id === streamId && stream.platform === "twitch" && stream.broadcasterId);
    if (!target?.broadcasterId) throw raidError("That channel is no longer live. Pick another.", 409, "raid_target_offline");
    const toId = target.broadcasterId;
    return this.withRaidGrant(userId, async grant => {
      if (grant.platformUserId === toId) throw raidError("You cannot raid your own channel.", 400, "raid_self");
      const entry = /** @type {RaidEntry} */ ({ id: randomUUID(), dir: "out", channel: clip(target.channel, 60), viewers: target.viewers, state: "pending", at: this.now() });
      await this.deps.users.updateOne({ userId }, prependHistory(entry));
      try {
        await this.deps.provider.start(grant, toId);
      } catch (error) {
        const failure = /** @type {{ status?: number, uncertain?: boolean }} */ (error);
        const unconfirmed = failure.uncertain === true;
        await this.settle(userId, entry.id, unconfirmed ? "unconfirmed" : "failed", unconfirmed ? "provider_unconfirmed" : `twitch_${failure.status ?? "error"}`);
        throw unconfirmed ? raidError("Twitch did not confirm the raid. Check Twitch before trying again; this raid was not sent twice.", 502, "raid_unconfirmed")
          : raidFailureError(failure);
      }
      await this.settle(userId, entry.id, "queued");
      return { state: "queued", channel: entry.channel, id: entry.id };
    });
  }

  /** Cancel the pending raid. Twitch answers 404 when none is left.
   * @param {string} userId */
  async cancel(userId) {
    const history = await this.requireReady(userId);
    const latest = history.find(entry => entry.dir === "out" && entry.state === "queued");
    return this.withRaidGrant(userId, async grant => {
      try {
        await this.deps.provider.cancel(grant);
      } catch (error) {
        const failure = /** @type {{ status?: number, uncertain?: boolean }} */ (error);
        if (failure.status === 404) {
          if (latest) await this.settle(userId, latest.id, "closed");
          throw raidError("Twitch has no raid to cancel. It may already have started.", 409, "raid_not_pending");
        }
        if (failure.uncertain === true) throw raidError("Twitch did not confirm the cancel. Check Twitch to see whether the raid is still queued.", 502, "cancel_unconfirmed");
        throw raidFailureError(failure);
      }
      if (latest) await this.settle(userId, latest.id, "canceled");
      return { state: "canceled", channel: latest?.channel ?? "", id: latest?.id ?? "" };
    });
  }

  /** @param {string} userId @param {string} id @param {OutState} state @param {string} [reason] */
  async settle(userId, id, state, reason) {
    await this.deps.users.updateOne({ userId, [`${HISTORY_PATH}.id`]: id },
      { $set: { [`${HISTORY_PATH}.$.state`]: state, ...(reason ? { [`${HISTORY_PATH}.$.reason`]: reason } : {}) } });
  }

  /**
   * An incoming Twitch raid, kept in the history only for streamers who
   * switched raids on. `viewers` is the raid's size.
   * @param {string} userId @param {{ user: string, amount?: string, atMs: number, id: string }} event
   */
  async recordIncoming(userId, event) {
    const entry = /** @type {RaidEntry} */ ({ id: event.id, dir: "in", channel: clip(event.user, 60), viewers: Math.max(0, Math.trunc(Number(event.amount)) || 0), state: "received", at: event.atMs });
    await this.deps.users.updateOne({ userId, "preferences.twitchRaids.enabled": true },
      prependHistory(entry));
  }

  /** Called for every stored platform event; only a new Twitch raid matters.
   * @param {string} userId @param {import('./platformEvents').StoredEvent} event */
  onPlatformEvent(userId, event) {
    if (event.platform === "twitch" && event.kind === "raid") void this.recordIncoming(userId, event).catch(() => {});
  }
}

/**
 * Build the service and subscribe it to stored platform events, so raids the
 * streamer receives reach the history.
 *
 * @param {{ db: Pick<import('../db/connect').DbContext, 'users'>, config: { twitchRaidsEnabled?: boolean, platformIntegrations?: { twitch?: { clientId?: string } | null } },
 *   integrations: import('./platformIntegrations').PlatformIntegrationsService, liveStreams: LiveList }} deps
 */
function createTwitchRaids({ db, config, integrations, liveStreams }) {
  const transport = new TwitchAutomationProvider({ clientId: config.platformIntegrations?.twitch?.clientId || "" });
  const raids = new TwitchRaidsService({ enabled: config.twitchRaidsEnabled === true, users: /** @type {import('mongodb').Collection<UserRaidDoc>} */ (db.users), integrations, liveStreams, provider: new TwitchRaidProvider(transport) });
  integrations.events.afterInsert = (userId, event) => raids.onPlatformEvent(userId, event);
  return raids;
}

module.exports = { TwitchRaidsService, createTwitchRaids };
