"use strict";

const crypto = require("crypto");
const entries = require("../data/whatsNew.json");
const { deliverNotification } = require("./notificationDelivery");
const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const SEVERITIES = new Set(["info", "warning", "critical"]);
const AUDIENCES = new Set(["all", "website", "agent", "stream-studio", "guides"]);

class AnnouncementsService {
  /** @param {import('../db/connect').DbContext} db @param {{notifications: import('./notifications').NotificationsService, io?: import('socket.io').Server, logger?: import('pino').Logger, now?:()=>Date}} opts */
  constructor(db, opts) { this.db = db; this.notifications = opts.notifications; this.io = opts.io; this.logger = opts.logger; this.now = opts.now || (() => new Date()); }

  /** @param {string} userId */
  async deliverMajors(userId) {
    const cutoff = this.now().getTime() - 90 * 86400000;
    for (const entry of entries.filter((item) => item.major && Date.parse(item.date) >= cutoff && Date.parse(item.date) <= this.now().getTime()).slice(0, 20)) {
      await deliverNotification(this.notifications, userId, { kind: "whats_new", title: `What's new: ${entry.title}`, body: entry.summary,
        href: `/changelog#${entry.id}`, groupKey: `whats-new:${entry.id}`, eventKey: `whats-new:${entry.id}` }, this.logger);
    }
  }

  async current() { return serialize(await this.db.siteConfig.findOne({ _id: /** @type {any} */ ("banner") })); }

  /** @param {string} [audience] */
  async active(audience) {
    const banner = await this.current(); const now = this.now().getTime();
    return banner && Date.parse(banner.startsAt) <= now && Date.parse(banner.endsAt) > now
      && (!audience || banner.audience === "all" || banner.audience === audience) ? banner : null;
  }

  /** @param {any} input */
  async save(input) {
    const value = validate(input);
    const row = stampVersion({ _id: "banner", ...value, revision: input.expectedRevision + 1 }, COLLECTIONS.SITE_CONFIG);
    try {
      const saved = await this.db.siteConfig.findOneAndUpdate({ _id: /** @type {any} */ ("banner"), revision: input.expectedRevision }, { $set: row }, { upsert: input.expectedRevision === 0, returnDocument: "after" });
      if (!saved) throw problem(409, "announcement_changed", "This notice changed. Reload before saving.");
      const banner = serialize(saved); if (banner) this._broadcast(banner.hash); return banner;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 11000) throw problem(409, "announcement_changed", "This notice changed. Reload before saving.");
      throw error;
    }
  }

  /** @param {unknown} revision */
  async end(revision) {
    if (!Number.isInteger(revision) || Number(revision) < 1) throw problem(400, "bad_request", "Reload this notice before ending it.");
    const now = this.now();
    const row = await this.db.siteConfig.findOneAndUpdate({ _id: /** @type {any} */ ("banner"), revision },
      [{ $set: { endsAt: now, startsAt: { $min: ["$startsAt", new Date(now.getTime() - 1)] }, revision: { $add: ["$revision", 1] } } }], { returnDocument: "after" });
    if (!row) throw problem(409, "announcement_changed", "This notice changed. Reload before ending it.");
    const banner = serialize(row); if (banner) this._broadcast(banner.hash); return banner;
  }

  /** @param {string} hash */
  _broadcast(hash) { try { this.io?.emit("site:banner", { hash }); } catch (error) { this.logger?.warn({ err: error }, "site_banner_push_failed"); } }
}

/** @param {any} input */
function validate(input) {
  const message = typeof input?.message === "string" ? input.message.trim() : "";
  const href = typeof input?.href === "string" ? input.href.trim() : "";
  const startsAt = new Date(input?.startsAt); const endsAt = new Date(input?.endsAt);
  if (!Number.isInteger(input?.expectedRevision) || input.expectedRevision < 0 || !SEVERITIES.has(input?.severity) || !AUDIENCES.has(input?.audience)
    || !message || message.length > 240 || /[\u0000-\u001f\u007f]/.test(message)
    || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt
    || (href && (!href.startsWith("/") || href.startsWith("//") || href.includes("\\") || href.length > 300 || /[\u0000-\u0020\u007f]/.test(href)))) {
    throw problem(400, "bad_request", "Use 1–240 characters, a same-site link, an audience and an end time after the start.");
  }
  return { severity: input.severity, audience: input.audience, message, href: href || null, startsAt, endsAt };
}

/** @param {any} row */
function serialize(row) {
  if (!row) return null;
  const banner = { severity: row.severity, audience: row.audience, message: row.message, href: row.href || null,
    startsAt: new Date(row.startsAt).toISOString(), endsAt: new Date(row.endsAt).toISOString(), revision: row.revision };
  return { ...banner, hash: crypto.createHash("sha256").update(JSON.stringify(banner)).digest("hex").slice(0, 24) };
}
/** @param {number} status @param {string} code @param {string} message */
function problem(status, code, message) { return Object.assign(new Error(message), { status, code }); }
module.exports = { AnnouncementsService };
