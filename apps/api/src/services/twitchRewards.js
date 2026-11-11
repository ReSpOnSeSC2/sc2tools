"use strict";

const { randomUUID } = require("node:crypto");
const { sha256 } = require("../util/hash");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const { TWITCH_REWARD_SCOPE } = require("./platformOauthClients");
const { rewardError, safeText, rewardSettings, object } = require("./twitchRewardPolicy");

/** @typedef {import('./platformIntegrations').PlatformIntegrationsService} Integrations */
/** @typedef {import('./twitchRewardReceipts').TwitchRewardReceipts} Receipts */
/** @typedef {import('./twitchRewardProvider').TwitchRewardProvider} Provider */
/** @typedef {import('./twitchRewardActions').TwitchRewardActions} Actions */

/** @param {any} error */
const errorCode = error => typeof error?.code === "string" ? error.code : "";
/** @param {any} mapping @param {string|null} target @param {string|null} revision */
const mappingKey = (mapping, target, revision) => sha256(JSON.stringify([target, revision, mapping]));
/** @param {string} reason */
const refused = reason => ({ state: "skipped", reason });

class TwitchRewardsService {
  /** @param {{users:import('mongodb').Collection<any>,integrations:Integrations,receipts:Receipts,provider:Provider,actions:Actions,now?:()=>number}} deps */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    /** @type {ReturnType<typeof setInterval>|undefined} */ this.timer = undefined;
    /** @type {Promise<void>|null} */ this.sweepPending = null;
    /** @type {Map<string,Promise<void>>} */ this.deviceChecks = new Map();
    this.stopping = false;
  }

  /** @param {string} userId */
  async config(userId) {
    const row = await this.deps.users.findOne({ userId }, { projection: { "preferences.twitchRewards": 1 }, maxTimeMS: 1200 });
    return rewardSettings(row?.preferences?.twitchRewards);
  }

  /** @param {string} userId */
  async permissions(userId) {
    const result = await this.deps.integrations.statuses(userId);
    const twitch = result.platforms.find(row => row.platform === "twitch");
    return { available: twitch?.configured === true && twitch.streamingAvailable === true,
      permission: Boolean(twitch?.connected && twitch.rewardsConsent === true && twitch.scopes.includes(TWITCH_REWARD_SCOPE)) };
  }

  /** @param {string} userId */
  async status(userId) {
    const [settings, permissions, targets, builds, activity] = await Promise.all([this.config(userId), this.permissions(userId),
      this.deps.actions.targets(userId), this.deps.actions.builds(userId), this.deps.receipts.recent(userId)]);
    return { settings: { enabled: settings.enabled, target: settings.target, mappings: settings.mappings }, ...permissions, targets, builds, activity };
  }

  /** @param {string} userId */
  listRewards(userId) {
    return this.deps.integrations.withTwitchAutomationGrant(userId, { rewards: true }, grant => this.deps.provider.list(grant));
  }

  /** @param {string} userId @param {unknown} raw */
  createReward(userId, raw) {
    const input = object(raw);
    const title = typeof input.title === "string" ? safeText(input.title, 45) : "";
    if (!title || title !== input.title.trim() || !Number.isSafeInteger(input.cost) || input.cost < 1 || input.cost > 1_000_000
      || typeof input.requiresInput !== "boolean" || Object.keys(input).some(key => !["title", "cost", "requiresInput"].includes(key))) {
      throw rewardError("reward_create_invalid", 400, "Enter a plain reward title, a whole point cost, and an input choice.");
    }
    return this.deps.integrations.withTwitchAutomationGrant(userId, { rewards: true }, grant => this.deps.provider.create(grant,
      { title, cost: input.cost, requiresInput: input.requiresInput }));
  }

  /** @param {string} userId @param {unknown} raw */
  async save(userId, raw) {
    const next = rewardSettings(raw, true);
    const write = async (/** @type {string|null} */ broadcasterId) => {
      if (next.enabled && next.target && !await this.deps.actions.token(userId, next.target)) {
        throw rewardError("reward_target_unavailable", 409, "Choose an active overlay from this account.");
      }
      const result = await this.deps.users.updateOne({ userId }, { $set: { "preferences.twitchRewards": { ...next, broadcasterId, revision: randomUUID() } } });
      if (!result.matchedCount) throw rewardError("reward_owner_unavailable", 404);
      return { enabled: next.enabled, target: next.target, mappings: next.mappings };
    };
    // Disabling never needs a usable provider credential. It still serializes
    // with an in-flight action when this owner has a reward grant.
    if (!next.enabled) return this.deps.integrations.withTwitchRewardSettings(userId, async () => write((await this.config(userId)).broadcasterId));
    return this.deps.integrations.withTwitchAutomationGrant(userId, { rewards: true }, async grant => {
      const list = new Map((await this.deps.provider.list(grant)).map(reward => [reward.id, reward]));
      for (const mapping of next.mappings) {
        if (!mapping.enabled) continue;
        const found = list.get(mapping.rewardId);
        if (!found) throw rewardError("reward_mapping_unavailable", 409, "Choose a reward from the connected Twitch channel.");
        if (mapping.settlement !== "none" && (!found.manageable || found.autoSkipsQueue)) {
          throw rewardError("reward_settlement_unavailable", 409, "Automatic settlement requires a reward created here with its Twitch request queue enabled.");
        }
        if (mapping.action === "buildVote" && !(await this.deps.actions.buildVote(userId, mapping.buildIds))) {
          throw rewardError("reward_builds_unavailable", 409, "Choose two or three available saved builds with different names.");
        }
      }
      await grant.assertCurrent();
      return write(grant.platformUserId);
    });
  }

  /** A signed notification is acknowledged after this local write; the
   * worker alone checks provider liveness or performs provider mutations.
   * @param {string} userId @param {NonNullable<ReturnType<import('./twitchRewardPolicy').signedRedemption>>} redemption */
  async accept(userId, redemption) {
    const settings = await this.config(userId);
    const mapping = settings.mappings.find(value => value.rewardId === redemption.rewardId && value.enabled);
    if (!settings.enabled || settings.broadcasterId !== redemption.broadcasterId || !mapping || !(await this.permissions(userId)).permission) return false;
    const lease = await claimUserDataLease(this.deps.users, userId);
    try {
      // Only actions that use viewer text need it while awaiting dispatch.
      const data = ["pin", "tts"].includes(mapping.action) ? redemption : { ...redemption, input: "", login: "", name: "" };
      return await this.deps.receipts.accept(userId, data, mappingKey(mapping, settings.target, settings.revision), mapping.action);
    } finally { await lease.release(); }
  }

  /** @param {any} row @param {Record<string,any>|null} envelope */
  async process(row, envelope = null) {
    const { receipts, integrations, users, actions, provider } = this.deps;
    const lease = await claimUserDataLease(users, row.userId);
    try {
      await integrations.withTwitchAutomationGrant(row.userId, { rewards: true }, async grant => {
        const settings = await this.config(row.userId);
        const mapping = settings.mappings.find(value => value.rewardId === row.rewardId && value.enabled);
        if (!settings.enabled || !mapping || settings.broadcasterId !== row.broadcasterId || grant.platformUserId !== row.broadcasterId
          || mappingKey(mapping, settings.target, settings.revision) !== row.settingsKey) {
          if (await receipts.claim(row)) await receipts.finish(row, "skipped", "mapping_changed");
          return;
        }
        const token = settings.target ? await actions.token(row.userId, settings.target) : null;
        const expired = this.now() >= row.deadlineAt.getTime();
        const live = !expired && token ? await provider.isLive(grant) : false;
        if (!await receipts.claim(row)) return;
        await lease.assert(); await grant.assertCurrent();
        const outcome = await this.execute(row, envelope, mapping, token, expired, live);
        if (outcome.state === "awaiting_game") return;
        const status = row.providerStatus === "unfulfilled" ? settlementStatus(outcome.state, mapping.settlement) : null;
        let settlement = "none";
        if (status) {
          try { settlement = await provider.settle(grant, row.rewardId, row.redemptionId, status); }
          catch { settlement = "unconfirmed"; }
        }
        await receipts.finish(row, outcome.state, outcome.reason, settlement);
      });
    } catch (error) {
      // An unavailable/changed grant can never authorize a refund or write.
      // Leave transient provider reads pending until their finite deadline.
      const code = errorCode(error);
      if (["streaming_consent_required", "streaming_reconnect_required", "platform_disabled", "streaming_connection_changed"].includes(code)
          || this.now() >= row.deadlineAt.getTime()) {
        if (await receipts.claim(row)) await receipts.finish(row, "skipped", "connection_unavailable");
      }
    } finally { await lease.release(); }
  }

  /** @param {any} row @param {Record<string,any>|null} envelope @param {{buildIds:string[],cooldownSec:number}} mapping @param {string|null} token @param {boolean} expired @param {boolean} live */
  async execute(row, envelope, mapping, token, expired, live) {
    const { actions, receipts } = this.deps;
    if (expired) return refused(row.state === "awaiting_game" ? "next_game_unavailable" : "redemption_expired");
    if (!token) return refused("overlay_unavailable");
    if (!live) return refused("channel_offline");
    if (row.state === "pending" && !await receipts.admitViewer(row, mapping.cooldownSec)) return refused("viewer_cooldown");
    try {
      if (row.action === "randomizer" && row.state === "pending") {
        const ready = await actions.canQueueNextGame(row.userId, token);
        if (!ready) return refused("randomizer_unavailable");
        if (await receipts.waiting(row.userId)) return refused("next_game_already_queued");
        await receipts.waitForGame(row, ready.gameKey);
        return { state: "awaiting_game", reason: "next_game_queued" };
      }
      await actions.run(row.userId, token, row, mapping, envelope);
      return { state: "applied", reason: "action_dispatched" };
    } catch (error) {
      const code = errorCode(error);
      if (code === "reward_action_unconfirmed") return { state: "unknown", reason: "dispatch_unconfirmed" };
      if ((code === "reward_hold_active" || code === "reward_desktop_roll_local") && row.state === "awaiting_game") {
        const skippedGame = code === "reward_desktop_roll_local" ? envelope?.gameKey : null;
        await receipts.waitForGame(row, skippedGame || row.gameKey);
        return { state: "awaiting_game", reason: "next_game_queued" };
      }
      if (code.startsWith("reward_") || ["overlay_rotation_pending", "invalid_overlay_token"].includes(code)) return refused(code.replace(/^reward_/, ""));
      return { state: "unknown", reason: "dispatch_unconfirmed" };
    }
  }

  start() {
    if (this.timer || !this.deps.integrations.isConfigured("twitch")) return;
    this.stopping = false;
    this.timer = setInterval(() => this.wake(), 15_000); this.timer.unref(); this.wake();
  }

  wake() {
    if (this.timer && !this.stopping) setImmediate(() => { if (!this.stopping) void this.sweep().catch(() => {}); });
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.sweepPending, ...this.deviceChecks.values()]);
  }

  sweep() {
    if (!this.sweepPending) this.sweepPending = this.sweepOnce().finally(() => { this.sweepPending = null; });
    return this.sweepPending;
  }

  async sweepOnce() {
    const { receipts } = this.deps;
    await receipts.recoverUnknown();
    const waiting = await receipts.expiredWaiting(), pending = await receipts.pending();
    const selected = [], owners = new Set();
    for (const row of [...waiting, ...pending]) {
      if (owners.has(row.userId)) continue;
      owners.add(row.userId);
      selected.push(row);
      if (selected.length === 6) break;
    }
    await Promise.allSettled(selected.map(row => this.process(row)));
  }

  /** Called only for server-accepted, paired-device phases.
   * @param {string} userId @param {Record<string,any>} envelope */
  async onDeviceGame(userId, envelope) {
    if (this.stopping || !this.deps.integrations.isConfigured("twitch") || this.deviceChecks.has(userId) || this.deviceChecks.size >= 12
      || typeof envelope.gameKey !== "string" || !envelope.gameKey || envelope.gameKey.length > 120 || /[\p{Cc}]/u.test(envelope.gameKey)) return;
    if (!this.deps.actions.isDeviceMatch(userId, envelope)) return;
    const work = (async () => {
      const row = await this.deps.receipts.waiting(userId);
      if (row && row.gameKey !== envelope.gameKey) await this.process(row, envelope);
    })().finally(() => this.deviceChecks.delete(userId));
    this.deviceChecks.set(userId, work);
    await work;
  }
}

/** @param {string} state @param {string} setting @returns {'FULFILLED'|'CANCELED'|null} */
function settlementStatus(state, setting) {
  if (state === "applied" && ["fulfill", "both"].includes(setting)) return "FULFILLED";
  if (state === "skipped" && ["refund", "both"].includes(setting)) return "CANCELED";
  return null;
}

module.exports = { TwitchRewardsService };
