"use strict";

const { randomUUID } = require("crypto");
const REPAIRS = ["opponents", "replay-archive", "custom-builds"];

class DataRepairsService {
  /** @param {import('../db/connect').DbContext} db @param {{gdpr: import('./gdpr').GdprService, notifications: import('./notifications').NotificationsService, logger?: import('pino').Logger}} opts */
  constructor(db, opts) { this.db = db; this.gdpr = opts.gdpr; this.notifications = opts.notifications; this.logger = opts.logger; this.active = new Set(); /** @type {Set<Promise<void>>} */ this.pending = new Set(); }
  async drain() { await Promise.allSettled([...this.pending]); }
  /** @param {string} userId @param {string} kind */
  async start(userId, kind) {
    if (!REPAIRS.includes(kind)) throw Object.assign(new Error("repair_not_found"), { status: 404, code: "repair_not_found" });
    if (kind === "replay-archive" && !this.gdpr.replayFiles) throw Object.assign(new Error("replay_archive_unavailable"), { status: 503, code: "replay_archive_unavailable" });
    if (this.active.size >= 4) throw Object.assign(new Error("repairs_busy"), { status: 429, code: "repairs_busy" });
    const id = randomUUID(); this.active.add(id);
    let fence;
    try { fence = await this.gdpr._acquireMutationFence(userId, `repair_${kind}`); }
    catch (error) { this.active.delete(id); throw error; }
    const now = new Date(); const field = `repairs.${kind}`;
    let claimed = false;
    try {
      const result = await this.db.users.updateOne({ userId, $or: [{ [`${field}.requestedAt`]: { $exists: false } }, { [`${field}.requestedAt`]: { $lte: new Date(now.getTime() - 60 * 60 * 1000) } }] }, { $set: { [field]: { id, requestedAt: now, status: "running" } } });
      if (!result.modifiedCount) throw Object.assign(new Error("repair_rate_limited"), { status: 429, code: "repair_rate_limited" });
      claimed = true;
      if (!this.gdpr.backups) throw Object.assign(new Error("backups_unavailable"), { status: 503 });
      await this.gdpr._drainOpponentBuildOrderWriters(userId);
      if (this.gdpr.customBuilds) await this.gdpr.customBuilds.cancelUserReclassifications(userId);
      await this.gdpr.backups.create(userId, { type: "pre_action", label: `Before ${kind} repair`, assert: fence.assert });
    } catch (error) {
      if (claimed) await this.db.users.updateOne({ userId, [`${field}.id`]: id }, { $unset: { [field]: "" } });
      await this.gdpr._releaseMutationFence(userId, fence); this.active.delete(id); throw error;
    }
    // An accepted repair owns its fence until completion. Failures are persisted
    // and notified; they never become an unhandled background rejection.
    const task = this.run(userId, kind, id, field, fence); this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return { accepted: true, id, kind };
  }
  /** @param {string} userId @param {string} kind @param {string} id @param {string} field @param {{assert:()=>Promise<void>, id:string, timer:NodeJS.Timeout}} fence */
  async run(userId, kind, id, field, fence) {
    let success = false;
    try {
      await fence.assert();
      if (kind === "opponents") await this.gdpr.rebuildOpponentsAndHealForUser(userId);
      else if (kind === "custom-builds") {
        if (!this.gdpr.customBuilds) throw new Error("custom_builds_unavailable");
        await this.gdpr.customBuilds.reclassifyAll(userId, { assertLease: fence.assert });
      } else {
        if (!this.gdpr.replayFiles) throw new Error("replay_archive_unavailable");
        for await (const game of this.db.games.find({ userId, "replayFile.storedAt": { $exists: true } }, { projection: { gameId: 1, replayFile: 1 } }).batchSize(100)) {
          await fence.assert(); await this.gdpr.replayFiles.verifyAvailableMarker(userId, game.gameId, { ...game.replayFile, available: true });
        }
      }
      await fence.assert(); success = true;
      await this.db.users.updateOne({ userId, [`${field}.id`]: id }, { $set: { [`${field}.status`]: "complete", [`${field}.completedAt`]: new Date() } });
    } catch (error) {
      this.logger?.warn({ err: error, userId, kind }, "data_repair_failed");
      try { await this.db.users.updateOne({ userId, [`${field}.id`]: id }, { $set: { [`${field}.status`]: "failed", [`${field}.completedAt`]: new Date() } }); } catch (error) { this.logger?.warn({ err: error }, "data_repair_status_failed"); }
    } finally {
      try { await this.gdpr._releaseMutationFence(userId, fence); } catch (error) { this.logger?.warn({ err: error }, "data_repair_release_failed"); }
      this.active.delete(id);
    }
    try { await this.notifications.notify(userId, { kind: "data.repair", title: success ? "Data repair completed" : "Data repair needs attention", body: success ? `Your ${kind.replace(/-/g, " ")} repair has finished.` : "Open Backups & data to try again after the cooldown, or contact support.", href: "/settings?tab=backups", eventKey: `repair:${id}` }); }
    catch (error) { this.logger?.warn({ err: error }, "data_repair_notification_failed"); }
  }
}
module.exports = { DataRepairsService, REPAIRS };
