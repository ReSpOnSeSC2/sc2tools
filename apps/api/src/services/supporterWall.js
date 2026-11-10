"use strict";

const { ObjectId } = require("mongodb");
const { cleanDisplayName, containsBlockedTerm } = require("../util/contentFilter");

/**
 * The opt-in supporter wall on /donate.
 *
 * A signed-in player asks to be listed with a display name and an optional
 * short message, and must tick an explicit consent box. Entries start
 * pending and appear publicly only after an administrator approves them
 * (who checks them against their own donation records; this service never
 * calls a payment provider). The player can remove their entry at any time,
 * which deletes it; account deletion removes it too (gdpr.js).
 *
 * Public reads expose only approved display names, messages and months:
 * never account ids, emails or how much anyone gave.
 */

const NAME_MIN = 2;
const NAME_MAX = 40;
const MESSAGE_MAX = 80;
const RAW_MAX = 400;
const PUBLIC_LIMIT = 200;
const ADMIN_LIMIT = 100;
const STATUSES = Object.freeze(["pending", "approved", "rejected"]);
const SELF_KEYS = new Set(["displayName", "message", "consent"]);

/** @param {number} status @param {string} code @param {string} message */
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const plain = (/** @type {unknown} */ value) => !!value && typeof value === "object" && !Array.isArray(value);
/** UTC calendar month, "YYYY-MM". @param {Date} date */
const monthOf = (date) => date.toISOString().slice(0, 7);

/** @param {unknown} raw @param {number} max @param {string} field */
function cleanField(raw, max, field) {
  if (typeof raw !== "string" || raw.length > RAW_MAX) throw fail(400, `invalid_supporter_${field}`, field === "name" ? `Use a display name of ${NAME_MIN} to ${NAME_MAX} characters.` : `Keep the message to ${MESSAGE_MAX} characters.`);
  // Display-name hygiene for both fields: control and zero-width
  // characters and links never reach a public page.
  const value = cleanDisplayName(raw).trim();
  if (value.length > max) throw fail(400, `invalid_supporter_${field}`, field === "name" ? `Use a display name of ${NAME_MIN} to ${NAME_MAX} characters.` : `Keep the message to ${MESSAGE_MAX} characters.`);
  return value;
}

/**
 * The self-serve request body: `{ displayName, message?, consent: true }`.
 * @param {unknown} body
 */
function validateSupporterEntry(body) {
  if (!plain(body) || Object.keys(/** @type {object} */ (body)).some((key) => !SELF_KEYS.has(key))) throw fail(400, "invalid_supporter_entry", "Send a display name, an optional message and your consent.");
  const input = /** @type {Record<string, unknown>} */ (body);
  if (input.consent !== true) throw fail(400, "supporter_consent_required", "Agree to be listed publicly before adding yourself to the wall.");
  const displayName = cleanField(input.displayName, NAME_MAX, "name");
  if (displayName.length < NAME_MIN) throw fail(400, "invalid_supporter_name", `Use a display name of ${NAME_MIN} to ${NAME_MAX} characters.`);
  const message = input.message === undefined || input.message === null ? "" : cleanField(input.message, MESSAGE_MAX, "message");
  if (containsBlockedTerm(displayName) || (message && containsBlockedTerm(message))) throw fail(400, "supporter_entry_blocked", "Choose a different display name or message.");
  return { displayName, message };
}

/** @param {any} row */
function selfView(row) {
  if (!row) return null;
  return {
    displayName: String(row.displayName || ""),
    message: String(row.message || ""),
    month: String(row.month || ""),
    status: STATUSES.includes(row.status) ? row.status : "pending",
    consentAt: row.consentAt instanceof Date ? row.consentAt.toISOString() : null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
  };
}

class SupporterWallService {
  /**
   * @param {{ supporters: import('mongodb').Collection<any> }} db
   * @param {{ now?: () => Date }} [options]
   */
  constructor(db, options = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
  }

  /** @param {string} userId */
  async getSelf(userId) {
    return { entry: selfView(await this.db.supporters.findOne({ userId })) };
  }

  /**
   * Add or update the caller's entry. Every change needs review again.
   * @param {string} userId @param {unknown} body
   */
  async saveSelf(userId, body) {
    const { displayName, message } = validateSupporterEntry(body);
    const now = this.now();
    await this.db.supporters.updateOne(
      { userId },
      {
        $set: { displayName, message, month: monthOf(now), status: "pending", consentAt: now, updatedAt: now, reviewedAt: null, reviewedBy: null },
        $setOnInsert: { userId, createdAt: now },
      },
      { upsert: true },
    );
    return this.getSelf(userId);
  }

  /** Revocation: the entry is deleted, not hidden. @param {string} userId */
  async removeSelf(userId) {
    const result = await this.db.supporters.deleteOne({ userId });
    return { removed: result.deletedCount > 0, entry: null };
  }

  /** Approved entries only: this month first, then earlier months. */
  async listPublic() {
    const now = this.now();
    const rows = await this.db.supporters
      .find({ status: "approved" }, { projection: { _id: 0, displayName: 1, message: 1, month: 1 } })
      .sort({ month: -1, reviewedAt: -1 })
      .limit(PUBLIC_LIMIT)
      .toArray();
    const current = monthOf(now);
    const entries = rows
      .map((row) => ({ displayName: String(row.displayName || ""), message: String(row.message || ""), month: String(row.month || "") }))
      .filter((row) => row.displayName && /^\d{4}-\d{2}$/.test(row.month));
    return {
      month: current,
      thisMonth: entries.filter((row) => row.month === current).map(({ displayName, message }) => ({ displayName, message })),
      earlier: entries.filter((row) => row.month !== current),
    };
  }

  /** The moderation queue. @param {{ status?: unknown }} [query] */
  async listAdmin(query = {}) {
    const status = typeof query.status === "string" && STATUSES.includes(query.status) ? query.status : "pending";
    const rows = await this.db.supporters
      .find({ status }, { projection: { userId: 0 } })
      .sort({ updatedAt: -1 })
      .limit(ADMIN_LIMIT)
      .toArray();
    return {
      status,
      items: rows.map((row) => ({
        id: String(row._id),
        displayName: String(row.displayName || ""),
        message: String(row.message || ""),
        month: String(row.month || ""),
        status: row.status,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
      })),
    };
  }

  /** @param {string} id */
  objectId(id) {
    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) throw fail(404, "not_found", "That supporter entry no longer exists.");
    return new ObjectId(id);
  }

  /**
   * Approve or reject one entry.
   * @param {string} id @param {unknown} body @param {string} adminUserId
   */
  async review(id, body, adminUserId) {
    const status = plain(body) ? /** @type {any} */ (body).status : undefined;
    if (status !== "approved" && status !== "rejected") throw fail(400, "invalid_supporter_review", "Choose approved or rejected.");
    const result = await this.db.supporters.updateOne(
      { _id: this.objectId(id) },
      { $set: { status, reviewedAt: this.now(), reviewedBy: adminUserId } },
    );
    if (!result.matchedCount) throw fail(404, "not_found", "That supporter entry no longer exists.");
    return { id, status };
  }

  /** @param {string} id */
  async removeAdmin(id) {
    const result = await this.db.supporters.deleteOne({ _id: this.objectId(id) });
    if (!result.deletedCount) throw fail(404, "not_found", "That supporter entry no longer exists.");
    return { id, removed: true };
  }
}

module.exports = { SupporterWallService, validateSupporterEntry, NAME_MAX, MESSAGE_MAX };
