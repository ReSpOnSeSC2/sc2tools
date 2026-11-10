"use strict";

const { COLLECTIONS, CUSTOM_BUILD_LIBRARY } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { validateCustomBuild } = require("../validation/customBuild");

/**
 * Build library safety and organisation for one account's private builds:
 * version history (``custom_build_revisions``), the 30-day "Recently
 * deleted" trash and its purge, pin and tags, JSON export and import.
 *
 * Every write of build content still goes through the caller's normal save
 * (routes/customBuilds.js ``persistBuild``: upsert, history, replay
 * matching, share state); this service only reads, plans and records.
 */

/** What a revision keeps: the definition itself. Publication state, pin,
 * tags and community provenance are always the build's current ones. */
const VERSIONED_FIELDS = Object.freeze([
  "name", "race", "vsRace", "matchup", "description", "signature", "steps", "notes",
  "perspective", "sourceGameId", "opponentRace", "rules", "skillLevel", "winConditions",
  "losesTo", "transitionsInto", "schemaVersion", "source", "buildOrder",
]);

/** What an export carries (and an import accepts). Never publication state. */
const EXPORT_FIELDS = Object.freeze([...VERSIONED_FIELDS, "pinned", "tags", "forkedFrom"]);

const SLUG_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
const CONFLICT_CHOICES = Object.freeze(["skip", "copy", "overwrite"]);

/** @param {readonly string[]} fields */
function inclusion(fields) {
  /** @type {Record<string, 0|1>} */
  const projection = { _id: 0 };
  for (const field of fields) projection[field] = 1;
  return projection;
}

/** @param {Record<string, any>} source @param {readonly string[]} fields */
function pick(source, fields) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
  }
  return out;
}

/** Key-sorted JSON so two equal definitions compare equal. @param {unknown} value @returns {string} */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** @param {unknown} err */
function isDuplicateKey(err) {
  return !!err && typeof err === "object" && /** @type {any} */ (err).code === 11000;
}

/**
 * A URL-safe slug from a name; empty when nothing usable remains.
 * Example: `slugify("PvZ — 2 Gate (copy)")` → "pvz-2-gate-copy".
 * @param {string} name
 */
function slugify(name) {
  return String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80);
}

/**
 * The first free "<slug>-copy", "<slug>-copy-2", …; null after 50 tries.
 * @param {string} slug @param {Set<string>} taken
 */
function copySlug(slug, taken) {
  for (let n = 1; n <= 50; n += 1) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    const candidate = `${slug.slice(0, 80 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** @param {string} name */
function copyName(name) {
  const suffix = " (copy)";
  return `${String(name).slice(0, 120 - suffix.length)}${suffix}`;
}

/**
 * @typedef {{index: number, status: "invalid", slug?: string, name?: string, errors: string[]}} InvalidCandidate
 * @typedef {{index: number, status: "valid", slug: string, name: string, onConflict: string, value: Record<string, any>}} ValidCandidate
 */

class CustomBuildLibraryService {
  /**
   * @param {{
   *   customBuilds: import('mongodb').Collection,
   *   customBuildRevisions: import('mongodb').Collection,
   * }} db
   * @param {{ now?: () => number }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = opts.now || Date.now;
  }

  /**
   * The live build's definition as stored (the history's unit), or null.
   * @param {string} userId @param {string} slug
   */
  async readDefinition(userId, slug) {
    const row = await this.db.customBuilds.findOne(
      { userId, slug, deletedAt: { $exists: false } },
      { projection: inclusion(VERSIONED_FIELDS) },
    );
    return row ? pick(row, VERSIONED_FIELDS) : null;
  }

  /**
   * Keep ``previous`` (the definition a save is about to replace) as the
   * build's newest revision, unless the save changes nothing; at most
   * REVISIONS_PER_BUILD stay.
   *
   * @param {string} userId @param {string} slug
   * @param {Record<string, any>|null} previous from ``readDefinition``
   * @param {Record<string, any>} [next] the definition being saved
   * @returns {Promise<number|null>} the new revision number
   */
  async recordRevision(userId, slug, previous, next) {
    if (!previous) return null;
    if (next && canonicalJson(pick(next, VERSIONED_FIELDS)) === canonicalJson(previous)) return null;
    const [latest] = await this.db.customBuildRevisions
      .find({ userId, slug }, { projection: { _id: 0, rev: 1 } })
      .sort({ rev: -1 }).limit(1).toArray();
    let rev = (Number(latest?.rev) || 0) + 1;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.db.customBuildRevisions.insertOne(stampVersion(
          { userId, slug, rev, savedAt: new Date(this.now()), doc: previous },
          COLLECTIONS.CUSTOM_BUILD_REVISIONS,
        ));
        break;
      } catch (err) {
        // Two saves of one build at once: take the next number.
        if (!isDuplicateKey(err) || attempt >= 2) throw err;
        rev += 1;
      }
    }
    const [oldestKept] = await this.db.customBuildRevisions
      .find({ userId, slug }, { projection: { _id: 0, rev: 1 } })
      .sort({ rev: -1 }).skip(CUSTOM_BUILD_LIBRARY.REVISIONS_PER_BUILD - 1).limit(1).toArray();
    if (oldestKept) {
      await this.db.customBuildRevisions.deleteMany({ userId, slug, rev: { $lt: oldestKept.rev } });
    }
    return rev;
  }

  /**
   * Newest first; ``build`` is the definition that revision held.
   * @param {string} userId @param {string} slug
   */
  async listRevisions(userId, slug) {
    const rows = await this.db.customBuildRevisions
      .find({ userId, slug }, { projection: { _id: 0, rev: 1, savedAt: 1, doc: 1 } })
      .sort({ rev: -1 }).limit(CUSTOM_BUILD_LIBRARY.REVISIONS_PER_BUILD).toArray();
    return rows.map((row) => ({ rev: row.rev, savedAt: row.savedAt, build: pick(row.doc || {}, VERSIONED_FIELDS) }));
  }

  /** @param {string} userId @param {string} slug @param {number} rev */
  async getRevision(userId, slug, rev) {
    const row = await this.db.customBuildRevisions.findOne(
      { userId, slug, rev },
      { projection: { _id: 0, doc: 1 } },
    );
    return row && row.doc ? pick(row.doc, VERSIONED_FIELDS) : null;
  }

  /** Builds deleted within the retention window, newest first. @param {string} userId */
  async listTrash(userId) {
    const now = this.now();
    const filter = { userId, deletedAt: { $gte: new Date(now - CUSTOM_BUILD_LIBRARY.TRASH_RETENTION_MS) } };
    const [rows, total] = await Promise.all([
      this.db.customBuilds
        .find(filter, { projection: { _id: 0, slug: 1, name: 1, race: 1, vsRace: 1, perspective: 1, deletedAt: 1 } })
        .sort({ deletedAt: -1, slug: 1 }).limit(CUSTOM_BUILD_LIBRARY.TRASH_LIST_MAX).toArray(),
      this.db.customBuilds.countDocuments(filter),
    ]);
    return {
      items: rows.map((row) => ({
        slug: String(row.slug),
        name: typeof row.name === "string" ? row.name.slice(0, 120) : String(row.slug),
        race: typeof row.race === "string" ? row.race : null,
        vsRace: typeof row.vsRace === "string" ? row.vsRace : null,
        perspective: row.perspective === "opponent" ? "opponent" : "you",
        deletedAt: row.deletedAt,
        purgeAt: new Date(new Date(row.deletedAt).getTime() + CUSTOM_BUILD_LIBRARY.TRASH_RETENTION_MS),
      })),
      total,
      retentionDays: Math.round(CUSTOM_BUILD_LIBRARY.TRASH_RETENTION_MS / 86_400_000),
    };
  }

  /**
   * Bring a build back from the trash, privately: deleting it removed its
   * Community listing and restoring never republishes. The caller re-runs
   * replay matching (ADR 0025: frozen check-ins return to the card).
   * @param {string} userId @param {string} slug
   * @returns {Promise<boolean>} false when it isn't in the trash
   */
  async restoreDeleted(userId, slug) {
    const now = this.now();
    const res = await this.db.customBuilds.updateOne(
      { userId, slug, deletedAt: { $gte: new Date(now - CUSTOM_BUILD_LIBRARY.TRASH_RETENTION_MS) } },
      { $unset: { deletedAt: "" }, $set: { isPublic: false, shareWithCommunity: false, updatedAt: new Date(now) } },
    );
    return res.matchedCount > 0;
  }

  /**
   * Pin and tags: organisation only, so no history, replay matching or
   * "edited" time.
   * @param {string} userId @param {string} slug @param {{pinned?: boolean, tags?: string[]}} meta
   */
  async patchMeta(userId, slug, meta) {
    /** @type {Record<string, unknown>} */
    const $set = {};
    if (meta.pinned !== undefined) $set.pinned = meta.pinned;
    if (meta.tags !== undefined) $set.tags = meta.tags;
    const res = await this.db.customBuilds.updateOne({ userId, slug, deletedAt: { $exists: false } }, { $set });
    return res.matchedCount > 0 ? { slug, ...$set } : null;
  }

  /**
   * A saved community copy acknowledges the author's newer version without
   * taking it ("Dismiss").
   * @param {string} userId @param {string} slug @param {string} version
   */
  async acknowledgeForkVersion(userId, slug, version) {
    const res = await this.db.customBuilds.updateOne(
      { userId, slug, deletedAt: { $exists: false }, "forkedFrom.communitySlug": { $type: "string" } },
      { $set: { "forkedFrom.version": version } },
    );
    return res.matchedCount > 0;
  }

  /** Every live build as validated JSON (newest first). @param {string} userId */
  async exportAll(userId) {
    const rows = await this.db.customBuilds
      .find({ userId, deletedAt: { $exists: false } }, { projection: inclusion(["slug", ...EXPORT_FIELDS]) })
      .sort({ updatedAt: -1, slug: 1 }).limit(CUSTOM_BUILD_LIBRARY.LIBRARY_MAX).toArray();
    const builds = [];
    let skipped = 0;
    for (const row of rows) {
      const checked = validateCustomBuild({ slug: row.slug, ...pick(row, EXPORT_FIELDS) });
      if (checked.valid) builds.push(checked.value);
      else skipped += 1;
    }
    return {
      format: "sc2tools-custom-builds",
      version: 1,
      exportedAt: new Date(this.now()).toISOString(),
      builds,
      ...(skipped ? { skipped } : {}),
    };
  }

  /**
   * Plan (``dryRun``) or apply one import batch. Each item is validated
   * like a save; a slug already in the library is a conflict the player
   * resolves per item (skip, copy as "<name> (copy)", or overwrite, which
   * keeps the replaced version in history). Imported builds are private,
   * carry ``source: "import"`` and never trigger matching here: the caller
   * re-matches once after the last batch.
   *
   * @param {string} userId
   * @param {Array<{build?: unknown, onConflict?: unknown}>} items at most IMPORT_BATCH_MAX
   * @param {{
   *   dryRun?: boolean,
   *   save?: (slug: string, value: Record<string, any>, previous: Record<string, any>|null) => Promise<void>,
   * }} opts
   */
  async importBatch(userId, items, opts = {}) {
    const planned = items.map((item, index) => this._candidate(item, index));
    const slugs = [...new Set(planned.flatMap((entry) => (entry.slug ? [entry.slug] : [])))];
    const [existing, liveCount, allSlugs] = await Promise.all([
      this.db.customBuilds.find({ userId, slug: { $in: slugs } }, { projection: { _id: 0, slug: 1, deletedAt: 1 } }).toArray(),
      this.db.customBuilds.countDocuments({ userId, deletedAt: { $exists: false } }),
      this.db.customBuilds.distinct("slug", { userId }),
    ]);
    const live = new Set(existing.filter((row) => !row.deletedAt).map((row) => String(row.slug)));
    const taken = new Set(allSlugs.map(String));
    let creates = 0;
    /** @type {Array<Record<string, any>>} */
    const results = planned.map((entry) => {
      if (entry.status === "invalid") return entry;
      const conflict = live.has(entry.slug);
      const choice = entry.onConflict;
      if (opts.dryRun) return { ...entry, status: conflict ? "conflict" : "new" };
      if (conflict && choice === "skip") return { ...entry, status: "skipped" };
      if (conflict && choice === "overwrite") return { ...entry, status: "overwritten" };
      // New builds, copies and slugs only the trash still holds get a free slug.
      const fresh = taken.has(entry.slug) ? copySlug(entry.slug, taken) : entry.slug;
      if (!fresh) return { index: entry.index, status: "invalid", errors: ["no free name for a copy"] };
      taken.add(fresh);
      creates += 1;
      const value = conflict ? { ...entry.value, slug: fresh, name: copyName(entry.value.name) } : { ...entry.value, slug: fresh };
      return { ...entry, slug: fresh, value, status: conflict ? "copied" : "created" };
    });
    if (opts.dryRun) return { results: results.map(publicResult), libraryCount: liveCount };
    if (liveCount + creates > CUSTOM_BUILD_LIBRARY.LIBRARY_MAX) {
      throw Object.assign(new Error("library_full"), { status: 409, code: "library_full" });
    }
    for (const entry of results) {
      if (!opts.save || !("value" in entry) || entry.status === "skipped" || entry.status === "invalid") continue;
      try {
        const previous = entry.status === "overwritten" ? await this.readDefinition(userId, entry.slug) : null;
        await opts.save(entry.slug, entry.value, previous);
      } catch (err) {
        Object.assign(entry, { status: "failed", errors: [err instanceof Error ? err.message.slice(0, 120) : "save_failed"] });
      }
    }
    return { results: results.map(publicResult), libraryCount: liveCount + creates };
  }

  /**
   * @param {{build?: unknown, onConflict?: unknown}} item @param {number} index
   * @returns {InvalidCandidate|ValidCandidate}
   */
  _candidate(item, index) {
    const raw = item && typeof item === "object" ? item.build : undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { index, status: "invalid", errors: ["not a build"] };
    const build = /** @type {Record<string, any>} */ (raw);
    const name = typeof build.name === "string" ? build.name.trim() : "";
    const slug = typeof build.slug === "string" && SLUG_PATTERN.test(build.slug) ? build.slug : slugify(name);
    if (!slug) return { index, status: "invalid", name: name.slice(0, 120), errors: ["the build needs a name"] };
    const checked = validateCustomBuild({ ...pick(build, EXPORT_FIELDS), name, slug, source: "import" });
    if (!checked.valid) return { index, status: "invalid", slug, name: name.slice(0, 120), errors: checked.errors.slice(0, 3) };
    const onConflict = CONFLICT_CHOICES.includes(/** @type {string} */ (item.onConflict)) ? String(item.onConflict) : "skip";
    return { index, status: "valid", slug, name, onConflict, value: /** @type {Record<string, any>} */ (checked.value) };
  }

  /**
   * Hard-delete builds that have been in the trash past the retention
   * window, with their history. A build restored meanwhile is kept.
   * @returns {Promise<{purged: number}>}
   */
  async purgeExpiredTrash() {
    const cutoff = new Date(this.now() - CUSTOM_BUILD_LIBRARY.TRASH_RETENTION_MS);
    let purged = 0;
    for (;;) {
      const rows = await this.db.customBuilds
        .find({ deletedAt: { $lt: cutoff } }, { projection: { _id: 1, userId: 1, slug: 1 } })
        .limit(CUSTOM_BUILD_LIBRARY.PURGE_BATCH).toArray();
      for (const row of rows) {
        const res = await this.db.customBuilds.deleteOne({ _id: row._id, deletedAt: { $lt: cutoff } });
        if (!res.deletedCount) continue;
        purged += 1;
        await this.db.customBuildRevisions.deleteMany({ userId: row.userId, slug: row.slug });
      }
      if (rows.length < CUSTOM_BUILD_LIBRARY.PURGE_BATCH) return { purged };
    }
  }
}

/** @param {Record<string, any>} entry */
function publicResult(entry) {
  return {
    index: entry.index,
    status: entry.status,
    ...(entry.slug ? { slug: entry.slug } : {}),
    ...(entry.name ? { name: String(entry.name).slice(0, 120) } : {}),
    ...(entry.errors ? { errors: entry.errors } : {}),
  };
}

module.exports = {
  CustomBuildLibraryService,
  VERSIONED_FIELDS,
  EXPORT_FIELDS,
  canonicalJson,
  slugify,
};
