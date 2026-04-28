"use strict";

const { LIMITS, SORT_OPTIONS } = require("../constants");
const { toStored, toPublic, clampPageSize } = require("./buildSerialiser");
const { encodeCursor, decodeCursor } = require("../util/cursor");
const { httpError } = require("../util/httpError");

/**
 * Domain logic for community builds. All callers are expected to have
 * validated input first. Errors thrown here use HttpError so the global
 * handler can translate them to status + code.
 */
class BuildsService {
  /** @param {{ builds: import('mongodb').Collection }} db */
  constructor(db) {
    this.builds = db.builds;
  }

  /** @param {Record<string, any>} body @param {{ clientId: string, now: number }} ctx */
  async create(body, ctx) {
    const existing = await this.builds.findOne({ id: body.id });
    if (existing) throw httpError(409, "build_exists");
    const doc = toStored(body, ctx);
    await this.builds.insertOne(doc);
    return toPublic(doc);
  }

  /** @param {string} id @param {Record<string, any>} body @param {{ clientId: string, now: number }} ctx */
  async replace(id, body, ctx) {
    if (body.id !== id) throw httpError(400, "id_mismatch");
    const existing = await this.builds.findOne({ id });
    if (!existing || existing.deletedAt) throw httpError(404, "not_found");
    if (existing.authorClientId !== ctx.clientId) throw httpError(403, "not_author");
    const next = toStored(body, {
      clientId: ctx.clientId,
      now: ctx.now,
      version: (existing.version ?? 1) + 1,
    });
    next.createdAt = existing.createdAt;
    next.upvotes = existing.upvotes;
    next.downvotes = existing.downvotes;
    next.flagged = existing.flagged;
    await this.builds.replaceOne({ id }, next);
    return toPublic(next);
  }

  /** @param {string} id @param {{ clientId: string, now: number }} ctx */
  async softDelete(id, ctx) {
    const existing = await this.builds.findOne({ id });
    if (!existing || existing.deletedAt) throw httpError(404, "not_found");
    if (existing.authorClientId !== ctx.clientId) throw httpError(403, "not_author");
    await this.builds.updateOne(
      { id },
      { $set: { deletedAt: ctx.now, updatedAt: ctx.now } },
    );
  }

  /** @param {string} id */
  async getById(id) {
    const doc = await this.builds.findOne({ id, deletedAt: null });
    if (!doc) return null;
    if (doc.flagged > LIMITS.FLAG_HIDE_THRESHOLD) return null;
    return toPublic(doc);
  }

  /**
   * @param {{ race?: string, vsRace?: string, q?: string, sort?: string,
   *           since?: number, cursor?: string, limit?: unknown }} query
   */
  async list(query) {
    const filter = buildListFilter(query);
    const sort = pickSort(query.sort);
    const limit = clampPageSize(query.limit);
    const cur = decodeCursor(query.cursor);
    if (cur) Object.assign(filter, cursorClause(cur, sort));
    const docs = await this.builds.find(filter).sort(sort).limit(limit + 1).toArray();
    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
      : null;
    return { builds: page.map((d) => /** @type {object} */ (toPublic(d))), nextCursor };
  }
}

/** @param {{ race?: string, vsRace?: string, q?: string, since?: number }} query */
function buildListFilter({ race, vsRace, q, since }) {
  /** @type {Record<string, unknown>} */
  const filter = { deletedAt: null, flagged: { $lte: LIMITS.FLAG_HIDE_THRESHOLD } };
  if (race) filter.race = race;
  if (vsRace) filter.vsRace = vsRace;
  if (q) filter.name = { $regex: escapeRegex(q), $options: "i" };
  if (Number.isFinite(Number(since))) filter.updatedAt = { $gte: Number(since) };
  return filter;
}

/** @param {string|undefined} sort @returns {Record<string, 1 | -1>} */
function pickSort(sort) {
  const choice = SORT_OPTIONS.includes(/** @type {string} */ (sort)) ? sort : "recent";
  if (choice === "votes") return { upvotes: -1, updatedAt: -1, id: 1 };
  return { updatedAt: -1, id: 1 };
}

/**
 * @param {{ updatedAt: number, id: string }} cur
 * @param {Record<string, 1 | -1>} sort
 * @returns {Record<string, unknown>}
 */
function cursorClause(cur, sort) {
  if (sort.upvotes === -1) return { updatedAt: { $lte: cur.updatedAt }, id: { $gt: cur.id } };
  return { $or: [
    { updatedAt: { $lt: cur.updatedAt } },
    { updatedAt: cur.updatedAt, id: { $gt: cur.id } },
  ] };
}

/** @param {string} value */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { BuildsService };
