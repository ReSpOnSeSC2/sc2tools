"use strict";

const STATUSES = new Set(["new", "looking", "fixed", "wontfix"]);
/** @type {Record<string,string>} */
const STATUS_LABELS = { new: "New", looking: "Looking into it", fixed: "Fixed", wontfix: "Won't fix" };

class SupportMessagesService {
  /** @param {import('../db/connect').DbContext} db @param {import('./notifications').NotificationsService} notifications @param {import('./adminEvents').AdminEventsService} adminEvents */
  constructor(db, notifications, adminEvents) {
    this.db = db; this.notifications = notifications; this.adminEvents = adminEvents;
  }

  /** Only the sender's last twenty reports, with no admin identities or diagnostics. @param {string} userId */
  async mine(userId) {
    const rows = await this.db.adminEvents.find(
      { type: "user_message", "payload.userId": userId, anonymizedAt: { $exists: false } },
      { projection: { eventId: 1, createdAt: 1, "payload.subject": 1, "payload.message": 1, report: 1 } },
    ).sort({ createdAt: -1, eventId: -1 }).limit(20).toArray();
    return { items: rows.map(publicReport) };
  }

  /** Compare-and-set keeps simultaneous status/reply edits from losing each other. @param {string} eventId @param {any} input */
  async update(eventId, input) {
    const requestId = typeof input?.requestId === "string" ? input.requestId.trim() : "";
    const reply = typeof input?.reply === "string" ? input.reply.trim() : "";
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0
      || (input.status !== undefined && !STATUSES.has(input.status)) || reply.length > 2000
      || (input.reply !== undefined && !reply) || (input.status === undefined && !reply)) {
      throw problem(400, "bad_request", "Choose a valid status or enter a reply of 1–2,000 characters.");
    }
    let row = await this.db.adminEvents.findOne({ eventId, type: "user_message", anonymizedAt: { $exists: false } });
    if (!row) throw problem(404, "not_found", "Report not found.");
    const previous = row.report || { status: "new", revision: 0, updates: [] };
    const retry = previous.updates.find((/** @type {any} */ item) => item.id === requestId);
    if (retry) {
      if (retry.reply !== reply || (input.status !== undefined && retry.status !== input.status)) throw problem(409, "report_request_conflict", "That reply request was already used.");
      await this._notify(row, retry); return publicReport(row);
    }
    if (previous.revision !== input.expectedRevision) throw problem(409, "report_changed", "This report changed. Reload before saving.");
    if (previous.updates.length >= 50) throw problem(409, "report_update_limit", "This report has reached its reply limit.");
    const status = input.status || previous.status;
    if (status === previous.status && !reply) return publicReport(row);
    const action = { id: requestId, status, statusChanged: status !== previous.status, reply, createdAt: new Date() };
    const report = { status, revision: previous.revision + 1, updates: [...previous.updates, action] };
    const saved = await this.db.adminEvents.findOneAndUpdate(
      { eventId, type: "user_message", anonymizedAt: { $exists: false }, ...(row.report ? { "report.revision": previous.revision } : { report: { $exists: false } }) },
      { $set: { report } }, { returnDocument: "after" },
    );
    if (!saved) throw problem(409, "report_changed", "This report changed. Reload before saving.");
    await this._notify(saved, action);
    this.adminEvents._broadcast(/** @type {any} */ (saved));
    return publicReport(saved);
  }

  /** A retry after a notification failure reuses the stored action's delivery keys. @param {any} row @param {any} action */
  async _notify(row, action) {
    const common = { href: "/settings?tab=help#my-reports", groupKey: `support:${row.eventId}` };
    if (action.statusChanged) await this.notifications.notify(row.payload.userId, {
      ...common, groupKey: `support-status:${row.eventId}:${action.id}`, kind: "support.status",
      eventKey: `support-status:${row.eventId}:${action.id}`,
      title: `Report status: ${STATUS_LABELS[action.status]}`, body: row.payload.subject,
    });
    if (action.reply) await this.notifications.notify(row.payload.userId, {
      ...common, kind: "support.reply", eventKey: `support-reply:${row.eventId}:${action.id}`,
      title: "You have a reply to your report", body: row.payload.subject,
    });
  }
}

/** @param {any} row */
function publicReport(row) {
  return { eventId: row.eventId, subject: row.payload.subject, message: row.payload.message,
    createdAt: new Date(row.createdAt).toISOString(), status: row.report?.status || "new", revision: row.report?.revision || 0,
    replies: (row.report?.updates || []).filter((/** @type {any} */ item) => item.reply).map((/** @type {any} */ item) => ({
      id: item.id, message: item.reply, createdAt: new Date(item.createdAt).toISOString(),
    })) };
}
/** @param {number} status @param {string} code @param {string} message */
function problem(status, code, message) { return Object.assign(new Error(message), { status, code }); }

module.exports = { SupportMessagesService };
