"use strict";

const { createHash } = require("crypto");
const { PREF_TYPE, sanitizeTwitchAutomation, eligibility, predictionTitle, markerDescription, plain } = require("./twitchAutomationPolicy");
const { claimUserDataLease } = require("../middleware/userDataWriteFence");
const RETRY_MS = 60_000;
/** @typedef {import('./twitchAutomationProvider').TwitchAutomationProvider & {}} Provider */
/** @typedef {import('./twitchAutomationProvider').Grant & {connectionRevision:string}} Grant */
/** @param {string} accountId @param {{name?:unknown,race?:unknown}} opponent @param {unknown} myRace */
function opponentKey(accountId, opponent, myRace) {
  /** @param {unknown} value */
  const race = value => plain(value).toLowerCase().replace(/^p$/, "protoss").replace(/^t$/, "terran").replace(/^z$/, "zerg").replace(/^r$/, "random");
  return createHash("sha256").update(JSON.stringify([accountId, plain(opponent.name).toLowerCase(), race(opponent.race), race(myRace)])).digest("hex");
}
/** Only public control/status fields leave this service. Never include provider
 * credentials, account IDs, game keys containing names, outcome IDs or errors.
 * @param {any} row */
function receiptStatus(row) {
  if (!row) return null;
  const prediction = row.prediction || {}, marker = row.marker || {};
  return { prediction: prediction.status, marker: marker.status, reason: prediction.reason || row.reason || null,
    canCancel: ["pending", "creating", "active", "locked", "unknown"].includes(prediction.status),
    canResolve: ["active", "locked", "unknown"].includes(prediction.status) && row.settlement?.action === "resolve" && Boolean(prediction.winId && prediction.lossId),
    deadlineAt: row.deadlineAt instanceof Date ? row.deadlineAt.toISOString() : null };
}

/** Provider work is bounded process-wide; provider connection leases serialize
 * each owner's rematch check, exact receipt, provider operation and commit.
 * There is no provider work on the 1Hz progress path or a default-off account. */
class TwitchAutomationService {
  /** @param {{users:Pick<import('./users').UsersService,'getPreferences'>,
   * integrations:import('./platformIntegrations').PlatformIntegrationsService,
   * receipts:import('./twitchAutomationReceipts').TwitchAutomationReceipts,provider:Provider,
   * usersCollection:import('mongodb').Collection<any>,isCurrent?:(userId:string,envelope:Record<string,any>)=>boolean,now?:()=>number}} deps */
  constructor(deps) {
    this.deps = deps; this.now = deps.now || Date.now; this.active = 0;
    /** @type {Promise<{checked:number}>|null} */ this.recovering = null;
    /** @type {Map<string,{until:number,value:boolean}>} */ this.eligible = new Map();
  }

  /** No queue or background retry of an overloaded CREATE. @template T @param {()=>Promise<T>} callback */
  async admitted(callback) {
    if (this.active >= 2) throw Object.assign(new Error("Twitch automation is busy. Check status shortly."), { status: 409, code: "twitch_automation_busy" });
    this.active++; try { return await callback(); } finally { this.active--; }
  }
  /** Background work must participate in the same erasure drain as HTTP writes.
   * @template T @param {string} userId @param {()=>Promise<T>} callback */
  async withOwner(userId, callback) {
    const lease = await claimUserDataLease(this.deps.usersCollection, userId);
    try { await lease.assert(); return await callback(); } finally { await lease.release(); }
  }
  /** @param {string} userId */
  async preferences(userId) { return sanitizeTwitchAutomation(await this.deps.users.getPreferences(userId, PREF_TYPE)); }
  /** @param {Grant} grant */
  async eligibleBroadcaster(grant) {
    const key = `${grant.platformUserId}:${grant.connectionRevision}`, hit = this.eligible.get(key);
    if (hit && hit.until > this.now()) return hit.value;
    const value = (await this.deps.provider.broadcaster(grant)).eligible;
    if (this.eligible.size >= 256) { const oldest = this.eligible.keys().next().value; if (oldest) this.eligible.delete(oldest); }
    this.eligible.set(key, { until: this.now() + 60_000, value }); return value;
  }
  /** @param {string} userId @param {any} row @param {Grant} grant */
  async ownedReceipt(userId, row, grant) {
    if (!row || row.userId !== userId || row.accountId !== grant.platformUserId) return null;
    await grant.assertCurrent();
    return row.connectionRevision === grant.connectionRevision ? row : this.deps.receipts.renewConnection(userId, row.gameKey, row.accountId, row.connectionRevision, grant.connectionRevision);
  }

  /** Called only after accepted authenticated device publication. Production
   * passes null queue evidence: current desktop has no trusted ranked signal.
   * @param {string} userId @param {Record<string,any>} envelope
   * @param {{source:string,receivedAt:number}} source
   * @param {{ranked1v1:boolean,source:'verified-live-queue'}|null} [queueEvidence] */
  async onLive(userId, envelope, source, queueEvidence = null) {
    const policy = eligibility(envelope, source, this.now(), queueEvidence);
    if (!["match_loading", "match_started"].includes(envelope.phase) || !policy.marker && policy.reason !== "ranked_status_unavailable" && !policy.prediction) return null;
    const prefs = await this.preferences(userId);
    if (!prefs.predictionsEnabled && !prefs.markersEnabled) return null;
    const prediction = prefs.predictionsEnabled && policy.prediction;
    const marker = prefs.markersEnabled && (policy.marker || envelope.phase === "match_loading");
    if (!prediction && !marker) return { prediction: "skipped", marker: "disabled", reason: policy.reason };
    return this.admitted(() => this.withOwner(userId, () => this.deps.integrations.withTwitchAutomationGrant(userId, { predictions: prediction, markers: marker }, async grant => {
      let row = await this.deps.receipts.read(userId, envelope.gameKey);
      if (row && !await this.ownedReceipt(userId, row, grant)) return null;
      if (!row) {
        if (!await this.eligibleBroadcaster(grant) || !await this.deps.provider.isLive(grant)) return null;
        const opponent = opponentKey(grant.platformUserId, envelope.opponent, envelope.user.race);
        const rematch = prediction && await this.deps.receipts.recentOpponent(userId, opponent, envelope.gameKey);
        const stamp = Number(String(envelope.gameKey).split("|").at(-1));
        row = await this.deps.receipts.reserve(userId, envelope.gameKey, { accountId: grant.platformUserId, connectionRevision: grant.connectionRevision,
          opponentKey: opponent, matchStartedAt: new Date(Number.isFinite(stamp) && Math.abs(this.now() - stamp) < 60_000 ? stamp : this.now()),
          prediction: prediction && !rematch ? "pending" : prefs.predictionsEnabled ? "skipped" : "disabled",
          marker: marker ? envelope.phase === "match_loading" ? "waiting" : "pending" : "disabled",
          reason: rematch ? "rematch_cooldown" : prefs.predictionsEnabled && !prediction ? policy.reason || undefined : undefined });
      }
      const current = () => this.deps.isCurrent && !this.deps.isCurrent(userId, envelope) ? null : eligibility(envelope, source, this.now(), queueEvidence);
      if (prediction && row.prediction.status === "pending") await this.createPrediction(userId, row, grant, prefs, envelope, () => Boolean(current()?.prediction));
      if (policy.marker && marker && ["waiting", "pending"].includes(row.marker.status)) await this.createMarker(userId, row, grant, envelope, () => Boolean(current()?.marker));
      return receiptStatus(await this.deps.receipts.read(userId, envelope.gameKey));
    })));
  }

  /** @param {string} userId @param {any} row @param {Grant} grant @param {ReturnType<typeof sanitizeTwitchAutomation>} prefs @param {Record<string,any>} envelope @param {()=>boolean} current */
  async createPrediction(userId, row, grant, prefs, envelope, current) {
    const ticket = await this.deps.receipts.claim(userId, row.gameKey, "prediction", "pending", "creating"); if (!ticket) return;
    try {
      if (!current()) { await this.deps.receipts.finish(ticket, "error", { reason: "live_event_expired" }); return; }
      const fields = await this.deps.provider.createPrediction(grant, predictionTitle(prefs.titleTemplate, { me: envelope.user.name, opp: envelope.opponent.name, oppRace: envelope.opponent.race, oppMmr: envelope.opponent.mmr }), prefs.windowSec);
      row = await this.deps.receipts.finish(ticket, "active", fields);
      if (row?.settlement) await this.drain(userId, row, grant);
    } catch (error) { await this.failed(ticket, error, row); }
  }
  /** @param {string} userId @param {any} row @param {Grant} grant @param {Record<string,any>} envelope @param {()=>boolean} current */
  async createMarker(userId, row, grant, envelope, current) {
    const ticket = await this.deps.receipts.claim(userId, row.gameKey, "marker", row.marker.status, "creating"); if (!ticket) return;
    try {
      // Loading can precede start by minutes; recheck live/capability now.
      if (!await this.eligibleBroadcaster(grant) || !await this.deps.provider.isLive(grant)) {
        await this.deps.receipts.finish(ticket, "error", { reason: "channel_not_live_or_eligible" }); return;
      }
      if (!current()) { await this.deps.receipts.finish(ticket, "error", { reason: "live_event_expired" }); return; }
      const fields = await this.deps.provider.createMarker(grant, markerDescription({ opp: envelope.opponent.name, myRace: envelope.user.race, oppRace: envelope.opponent.race, map: envelope.map }));
      await this.deps.receipts.finish(ticket, "created", fields);
    } catch (error) { await this.failed(ticket, error, row); }
  }

  /** Failures keep safe scalar reasons only. Unknown create is never POSTed
   * again. A known exact ID can be read/reconciled or safely refunded later.
   * @param {any} ticket @param {unknown} error @param {any} row */
  async failed(ticket, error, row) {
    const failure = /** @type {any} */ (error), creating = ticket.status === "creating";
    const unknown = !creating || failure?.uncertain !== false;
    const partial = creating && ticket.kind === "prediction" && typeof failure.receipt?.predictionId === "string" ? { predictionId: failure.receipt.predictionId } : {};
    const known = row.prediction?.predictionId || partial.predictionId;
    await this.deps.receipts.finish(ticket, unknown ? "unknown" : "error", {
      reason: failure?.status === 401 || failure?.status === 403 ? "reconnect_required" : failure?.status === 429 ? "provider_rate_limited" : unknown ? "provider_unconfirmed" : "provider_rejected",
      ...partial, ...(unknown && ticket.kind === "prediction" && known ? { retryAt: new Date(creating ? row.deadlineAt : this.now() + RETRY_MS) } : {}) });
  }

  /** Exact stored IDs only; cancellation also works for an incomplete CREATE
   * receipt, whereas resolving never guesses/adopts missing outcome IDs.
   * @param {string} userId @param {any} row @param {Grant} grant */
  async drain(userId, row, grant) {
    row = await this.ownedReceipt(userId, await this.deps.receipts.read(userId, row.gameKey), grant); if (!row) return null;
    if ((!row.settlement || row.settlement.action === "resolve" && (!row.prediction.winId || !row.prediction.lossId)) && row.deadlineAt <= new Date(this.now())) {
      await this.deps.receipts.requestSettlement(userId, row.gameKey, { action: "cancel", reason: "result_timeout" }); row = await this.deps.receipts.read(userId, row.gameKey);
    }
    const lane = row.prediction, unknown = lane.status === "unknown";
    if (!["active", "locked", "unknown"].includes(lane.status) || !lane.predictionId || !unknown && !row.settlement) return receiptStatus(row);
    const resolve = row.settlement?.action === "resolve";
    if (resolve && (!lane.winId || !lane.lossId)) return receiptStatus(row);
    const ticket = await this.deps.receipts.claim(userId, row.gameKey, "prediction", lane.status, unknown ? "unknown" : resolve ? "resolving" : "canceling"); if (!ticket) return null;
    try {
      if (unknown) {
        const remote = await this.deps.provider.prediction(grant, lane.predictionId);
        if (["RESOLVED", "CANCELED"].includes(remote.status)) {
          await this.deps.receipts.finish(ticket, remote.status === "RESOLVED" ? "resolved" : "canceled"); return receiptStatus(await this.deps.receipts.read(userId, row.gameKey));
        }
        if (!row.settlement) {
          await this.deps.receipts.finish(ticket, lane.winId && lane.lossId ? remote.status === "LOCKED" ? "locked" : "active" : "unknown",
            lane.winId && lane.lossId ? {} : { reason: "outcome_ids_unavailable", retryAt: new Date(Math.max(this.now() + RETRY_MS, row.deadlineAt.getTime())) });
          return receiptStatus(await this.deps.receipts.read(userId, row.gameKey));
        }
      }
      const outcome = row.settlement?.outcome === "win" ? lane.winId : lane.lossId;
      await this.deps.provider.endPrediction(grant, lane.predictionId, resolve ? "RESOLVED" : "CANCELED", resolve ? outcome : undefined);
      await this.deps.receipts.finish(ticket, resolve ? "resolved" : "canceled");
    } catch (error) { await this.failed(ticket, error, row); }
    return receiptStatus(await this.deps.receipts.read(userId, row.gameKey));
  }

  /** Called with the freshly ingested replay and a broker-correlated key, not
   * public result inputs. Require replay start proximity AND exact matchup/name
   * identity; a same-opponent rematch must not settle the previous game.
   * @param {string} userId @param {string} gameKey @param {Record<string,any>} game */
  async settleVerifiedReplay(userId, gameKey, game) {
    const row = await this.deps.receipts.read(userId, gameKey); if (!row) return null;
    const started = new Date(game.startedAt).getTime(), ended = new Date(game.date).getTime();
    if (game.isResumedFromReplay || game.playerCount !== 2 || game.matchFormat && game.matchFormat !== "1v1" || !game.opponent
      || !Number.isFinite(started) || !(row.matchStartedAt instanceof Date) || Math.abs(started - row.matchStartedAt.getTime()) > 120_000
      || !Number.isFinite(ended) || ended > this.now() + 30_000 || this.now() - ended > 15 * 60_000
      || opponentKey(row.accountId, game.opponent, game.myRace) !== row.opponentKey || !Number.isFinite(game.durationSec) || game.durationSec < 0) return null;
    if (game.durationSec < 60) await this.deps.receipts.requestSettlement(userId, gameKey, { action: "cancel", reason: "short_game" });
    else if (game.isLadderGame === true && ["Victory", "Defeat"].includes(game.result)) await this.deps.receipts.requestSettlement(userId, gameKey, { action: "resolve", outcome: game.result === "Victory" ? "win" : "loss", reason: "verified_result" });
    else return null;
    return this.processReceipt(userId, gameKey);
  }
  /** Only a stored verified result is resolvable from Dock. No caller chooses
   * an outcome. Cancel records its durable intent even during CREATE.
   * @param {string} userId @param {string} gameKey @param {'resolve'|'cancel'} action */
  async action(userId, gameKey, action) {
    const row = await this.deps.receipts.read(userId, gameKey); if (!row) return null;
    if (action === "cancel") await this.deps.receipts.requestSettlement(userId, gameKey, { action: "cancel", reason: "dock_cancel" });
    else if (action !== "resolve" || row.settlement?.action !== "resolve") throw Object.assign(new Error("A verified replay result is required."), { status: 409, code: "twitch_result_unavailable" });
    return this.processReceipt(userId, gameKey);
  }
  /** @param {string} userId @param {string} gameKey */
  async processReceipt(userId, gameKey) {
    const row = await this.deps.receipts.read(userId, gameKey); if (!row) return null;
    if (["disabled", "skipped", "canceled", "resolved", "error"].includes(row.prediction.status) || !row.prediction.predictionId) return receiptStatus(row);
    return this.admitted(() => this.withOwner(userId, () => this.deps.integrations.withTwitchAutomationGrant(userId, { predictions: true }, grant => this.drain(userId, row, grant))));
  }

  /** One indexed metadata batch per minute, no replay reads or remote object
   * searches. Expired CREATE becomes unknown, never another POST. */
  async recover() {
    if (this.recovering) return this.recovering;
    const work = this.recoverBatch().finally(() => { if (this.recovering === work) this.recovering = null; }); this.recovering = work; return work;
  }
  async recoverBatch() {
    const rows = await this.deps.receipts.due(); let checked = 0;
    for (const row of rows) {
      try {
        await this.deps.receipts.expireWaitingMarker(row.userId, row.gameKey);
        await this.deps.receipts.abandonPendingMarker(row.userId, row.gameKey);
        if (row.prediction.status === "pending") await this.deps.receipts.requestSettlement(row.userId, row.gameKey, { action: "cancel", reason: "game_ended_before_create" });
        for (const kind of /** @type {const} */ (["prediction", "marker"])) {
          if (["creating", "locking", "resolving", "canceling"].includes(row[kind].status)) {
            const ticket = await this.deps.receipts.claim(row.userId, row.gameKey, kind, row[kind].status, "unknown");
            if (ticket) await this.deps.receipts.finish(ticket, "unknown", { reason: "worker_expired", ...(kind === "prediction" && row.prediction.predictionId ? { retryAt: new Date(this.now()) } : {}) });
          }
        }
        await this.processReceipt(row.userId, row.gameKey); checked++;
      } catch { /* A single disconnected/busy owner must not block the batch. */ }
    }
    return { checked };
  }
}

module.exports = { TwitchAutomationService, receiptStatus, opponentKey, RETRY_MS };
