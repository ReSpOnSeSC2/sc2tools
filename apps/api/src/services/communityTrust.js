"use strict";

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");

/**
 * Community trust signals: durable saves (one per account through the
 * unique ``community_saves`` pair), the publication ``version`` an
 * author's content edits bump, and the opt-in author record.
 */

const SLUG_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const VERSIONS_MAX_SLUGS = 50;
const RECORD_TTL_MS = 5 * 60 * 1000;
const RECORD_CACHE_MAX_OWNERS = 200;

/** Key-sorted JSON so equal content compares equal. @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    return `{${Object.entries(/** @type {Record<string, unknown>} */ (value))
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Whether a republish changes what savers see: the public snapshot, the
 * title or the description. Identity, votes and record visibility don't.
 * @param {Record<string, any>|null} existing the stored publication
 * @param {{title: string, description: string, build: Record<string, any>}} next
 */
function contentChanged(existing, next) {
  if (!existing) return true;
  return (existing.title || "") !== next.title
    || (existing.description || "") !== next.description
    || canonical(existing.build ?? null) !== canonical(next.build ?? null);
}

/**
 * The version a publication currently has; rows from before versioning
 * count as version 1.
 * @param {Record<string, any>|null|undefined} row
 */
function publicationVersion(row) {
  const value = Number(row && row.version);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * The upsert of one publish. A content change is an update savers hear
 * about (version + 1, new ``contentUpdatedAt``); a republish that changes
 * nothing public keeps the version. ``showRecord`` undefined keeps the
 * author's record choice (off on a first publish). Sets the version fields
 * on ``doc`` so a retry of the same write carries them.
 * @param {Record<string, any>|null} existing the stored publication
 * @param {Record<string, any>} doc the publication's ``$set`` (title, description, build, …)
 * @param {{now: Date, showRecord?: boolean}} opts
 */
function publicationMutation(existing, doc, opts) {
  const { now, showRecord } = opts;
  if (existing && contentChanged(existing, { title: doc.title || "", description: doc.description || "", build: doc.build })) {
    doc.version = publicationVersion(existing) + 1;
    doc.contentUpdatedAt = now;
  }
  if (existing && showRecord !== undefined) doc.showAuthorRecord = showRecord;
  const base = { createdAt: now, publishedAt: now, votes: 0 };
  return {
    $set: doc,
    $setOnInsert: existing
      ? base
      : { ...base, saves: 0, version: 1, contentUpdatedAt: now, showAuthorRecord: showRecord === true },
    $inc: { publicationSequence: 1 },
  };
}

/**
 * Count one account's "Save to my library" toward the publication's
 * ``saves`` once. The author's own saves and removed builds never count.
 * @param {import('../db/connect').DbContext} db
 * @param {string} userId
 * @param {string} slug the public slug
 * @param {Date} now
 * @returns {Promise<boolean>} whether this save was counted
 */
async function recordCommunitySave(db, userId, slug, now) {
  if (!SLUG_RE.test(slug)) return false;
  const row = await db.communityBuilds.findOne({ slug, removed: false }, { projection: { _id: 0, ownerUserId: 1 } });
  if (!row || row.ownerUserId === userId) return false;
  try {
    await db.communitySaves.insertOne(stampVersion({ slug, userId, savedAt: now }, COLLECTIONS.COMMUNITY_SAVES));
  } catch (err) {
    if (err && typeof err === "object" && /** @type {any} */ (err).code === 11000) return false;
    throw err;
  }
  await db.communityBuilds.updateOne({ slug }, { $inc: { saves: 1 } });
  return true;
}

/**
 * ``?slugs=a,b`` → at most 50 distinct valid public slugs; null when the
 * list is malformed.
 * @param {unknown} raw
 * @returns {string[]|null}
 */
function parseVersionSlugs(raw) {
  if (typeof raw !== "string" || raw.length > VERSIONS_MAX_SLUGS * 81) return null;
  const slugs = [...new Set(raw.split(",").map((slug) => slug.trim()).filter(Boolean))];
  if (slugs.length === 0 || slugs.length > VERSIONS_MAX_SLUGS || !slugs.every((slug) => SLUG_RE.test(slug))) return null;
  return slugs;
}

/**
 * Current version and content-update time of listed publications, for a
 * saver's "Author updated" badge. Removed or unknown slugs are left out.
 * @param {import('../db/connect').DbContext} db
 * @param {string[]} slugs
 */
async function communityVersions(db, slugs) {
  const rows = await db.communityBuilds
    .find({ slug: { $in: slugs }, removed: false }, { projection: { _id: 0, slug: 1, version: 1, contentUpdatedAt: 1, publishedAt: 1 } })
    .toArray();
  return rows.map((row) => ({
    slug: String(row.slug),
    version: publicationVersion(row),
    updatedAt: row.contentUpdatedAt || row.publishedAt || null,
  }));
}

/**
 * The author's W-L with each opted-in publication, from the owner replay
 * totals, cached briefly per owner so a listing costs one aggregate per
 * author at most every few minutes.
 */
class AuthorRecords {
  /**
   * @param {(ownerUserId: string, publicSlugs: string[]) => Promise<Array<{publicSlug: string, wins: number, losses: number}>>} load
   * @param {{now?: () => number}} [opts]
   */
  constructor(load, opts = {}) {
    this.load = load;
    this.now = opts.now || Date.now;
    /** @type {Map<string, {expiresAt: number, bySlug: Map<string, {wins: number, losses: number}>}>} */
    this.cache = new Map();
  }

  /**
   * @param {Array<Record<string, any>>} rows raw publications (with ownerUserId and showAuthorRecord)
   * @returns {Promise<Map<string, {wins: number, losses: number}>>} by public slug
   */
  async forRows(rows) {
    /** @type {Map<string, string[]>} */
    const byOwner = new Map();
    for (const row of rows) {
      if (row.showAuthorRecord !== true || typeof row.ownerUserId !== "string" || typeof row.slug !== "string") continue;
      byOwner.set(row.ownerUserId, [...(byOwner.get(row.ownerUserId) || []), row.slug]);
    }
    /** @type {Map<string, {wins: number, losses: number}>} */
    const out = new Map();
    await Promise.all([...byOwner].map(async ([owner, slugs]) => {
      const records = await this._owner(owner, slugs);
      for (const slug of slugs) {
        const record = records.get(slug);
        if (record) out.set(slug, record);
      }
    }));
    return out;
  }

  /** @param {string} owner @param {string[]} slugs */
  async _owner(owner, slugs) {
    const cached = this.cache.get(owner);
    if (cached && cached.expiresAt > this.now() && slugs.every((slug) => cached.bySlug.has(slug))) return cached.bySlug;
    const rows = await this.load(owner, slugs);
    const bySlug = new Map(cached && cached.expiresAt > this.now() ? cached.bySlug : []);
    for (const row of rows) {
      bySlug.set(row.publicSlug, { wins: Math.max(0, Number(row.wins) || 0), losses: Math.max(0, Number(row.losses) || 0) });
    }
    this.cache.delete(owner);
    this.cache.set(owner, { expiresAt: this.now() + RECORD_TTL_MS, bySlug });
    while (this.cache.size > RECORD_CACHE_MAX_OWNERS) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return bySlug;
  }
}

module.exports = {
  AuthorRecords,
  communityVersions,
  contentChanged,
  parseVersionSlugs,
  publicationMutation,
  publicationVersion,
  recordCommunitySave,
};
