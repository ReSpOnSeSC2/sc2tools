"use strict";

const { randomBytes } = require("crypto");
const { cleanDisplayName } = require("../util/contentFilter");
const { validPlayerSlug, safeIso } = require("../util/publicPlayerConfig");

const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const PRIVATE_ID_RE = /^[0-9a-z]{6,12}$/;
const ELIGIBLE_OWNER = { _gdprMutation: { $exists: false }, "publicProfile.enabled": true, "preferences.reports.stream": { $ne: false } };
const OWNER_FIELDS = { _id: 0, userId: 1, displayName: 1, "replaySharing.slug": 1, streamReportPublicEpoch: 1 };
const VISIBLE_REPORT = { reportState: { $ne: "building" } };

class StreamReportPublication {
  /** @param {Pick<import('../db/connect').DbContext, 'users'|'streamSessions'>} db */
  constructor(db) { this.db = db; }

  /** @param {Record<string, unknown>} filter */
  async eligibleOwner(filter) {
    const owner = await this.db.users.findOne({ ...filter, ...ELIGIBLE_OWNER }, { projection: OWNER_FIELDS, maxTimeMS: 3000 });
    const slug = owner?.replaySharing?.slug;
    if (!owner || !validPlayerSlug(slug)) return null;
    return { userId: owner.userId, slug, epoch: owner.streamReportPublicEpoch ?? null,
      name: cleanDisplayName(owner.displayName).slice(0, 80) || "SC2 Player" };
  }

  /** @param {string} userId @param {{publicId?: unknown, publicEpoch?: unknown}} report */
  async status(userId, report) {
    return publicationStatus(await this.eligibleOwner({ userId }), report);
  }

  /** @param {string} userId @param {unknown} streamId @param {unknown} enabled */
  async update(userId, streamId, enabled) {
    if (typeof enabled !== "boolean") throw publicationError(400, "invalid_stream_sharing", "Choose whether to share this report.");
    if (typeof streamId !== "string" || !PRIVATE_ID_RE.test(streamId)) throw notFound();
    const filter = { userId, streamId, ...VISIBLE_REPORT };
    const owner = await this.eligibleOwner({ userId });
    if (enabled && !owner) {
      if (!await this.db.streamSessions.findOne(filter, { projection: { _id: 1 } })) throw notFound();
      throw publicationError(409, "stream_sharing_unavailable", "Turn on your public player page and stream reports before sharing.");
    }
    const options = { returnDocument: /** @type {const} */ ("after"), projection: { _id: 0, publicId: 1, publicEpoch: 1 } };
    const result = enabled && owner
      ? await this.publish(filter, owner.epoch, options)
      : await this.db.streamSessions.findOneAndUpdate(filter, { $unset: { publicId: "", publicEpoch: "" } }, options);
    if (!result) throw notFound();
    return publicationStatus(await this.eligibleOwner({ userId }), result);
  }

  /** @param {Record<string, unknown>} filter @param {string|null} epoch @param {import('mongodb').FindOneAndUpdateOptions} options */
  async publish(filter, epoch, options) {
    const fresh = randomBytes(12).toString("base64url");
    return this.db.streamSessions.findOneAndUpdate(filter, [{ $set: {
      publicId: { $cond: [{ $eq: [{ $ifNull: ["$publicEpoch", null] }, epoch] }, { $ifNull: ["$publicId", fresh] }, fresh] },
      publicEpoch: epoch,
    } }], options);
  }

  /** @param {unknown} slug @param {unknown} publicId */
  async read(slug, publicId) {
    if (!validPlayerSlug(slug) || typeof publicId !== "string" || !PUBLIC_ID_RE.test(publicId)) return null;
    const owner = await this.eligibleOwner({ "replaySharing.slug": slug });
    if (!owner) return null;
    const report = await this.db.streamSessions.findOne({ userId: owner.userId, publicId, publicEpoch: owner.epoch, ...VISIBLE_REPORT }, {
      projection: { _id: 0, games: 1, wins: 1, losses: 1, hours: 1, startAt: 1, matchups: 1, "mmr.delta": 1 },
      maxTimeMS: 3000,
    });
    if (!report) return null;
    const current = await this.eligibleOwner({ userId: owner.userId, "replaySharing.slug": slug });
    return current && current.epoch === owner.epoch ? shapeReport(report, current) : null;
  }
}

/** @param {{slug: string, epoch: unknown}|null} owner @param {{publicId?: unknown, publicEpoch?: unknown}} report */
function publicationStatus(owner, report) {
  const id = typeof report.publicId === "string" && PUBLIC_ID_RE.test(report.publicId) ? report.publicId : null;
  const enabled = Boolean(owner && id && (report.publicEpoch ?? null) === owner.epoch);
  return { eligible: Boolean(owner), enabled, href: enabled && owner && id ? `/players/${owner.slug}/streams/${id}` : null };
}

/** @param {unknown} input */
const count = (input) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? Math.min(input, 300) : 0;

/** @param {any} row */
function record(row) {
  return { games: count(row?.games), wins: count(row?.wins), losses: count(row?.losses) };
}

/** @param {any} report @param {{name:string, slug:string}} owner */
function shapeReport(report, owner) {
  const date = safeIso(report.startAt);
  if (!date) return null;
  const rows = /** @type {Array<{name?: unknown}>} */ (Array.isArray(report.matchups) ? report.matchups : []);
  const matchups = rows.slice(0, 6).flatMap((row) =>
    typeof row?.name === "string" && /^[PTZR?]v[PTZR?]$/.test(row.name) ? [{ name: row.name, ...record(row) }] : []);
  const mmrDelta = report.mmr?.delta;
  return {
    player: owner.name, slug: owner.slug, date: date.slice(0, 10), ...record(report),
    hours: Number.isFinite(report.hours) ? Math.min(120, Math.max(0, report.hours)) : 0,
    mmrDelta: Number.isSafeInteger(mmrDelta) && Math.abs(mmrDelta) <= 10000 ? mmrDelta : null, matchups,
  };
}

function notFound() { return publicationError(404, "stream_report_not_found", "This stream report is unavailable."); }

/** @param {number} status @param {string} code @param {string} message */
function publicationError(status, code, message) { return Object.assign(new Error(message), { status, code }); }

module.exports = { StreamReportPublication };
