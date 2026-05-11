"use strict";

/**
 * Cloud schema versioning. Every document in `sc2tools_saas` carries
 * a `_schemaVersion: number` field. The API stamps it on write; on read,
 * `migrateDoc` rolls older versions forward through the migration chain.
 *
 * Mirrors the registry shape used by the local app's
 * `lib/schema_versioning.js`, so the patterns match between the
 * Express + Mongo cloud and the Node + JSON local install.
 *
 * Public API:
 *   getSpec(collection) -> { collection, currentVersion, versionKey } | null
 *   stampVersion(doc, collection)   // mutates + returns
 *   getOnDiskVersion(doc, collection) -> number | null
 *   migrateDoc(doc, collection, opts)
 *   assertNotTooNew(doc, collection) // throws SchemaTooNewError
 *   registerMigration(m)             // for tests + future migrations
 */

const { COLLECTIONS } = require("../config/constants");

class SchemaMigrationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "SchemaMigrationError";
  }
}
class SchemaTooNewError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "SchemaTooNewError";
  }
}

const VERSION_KEY = "_schemaVersion";

/**
 * Registry of every collection the API writes to. Bump `currentVersion`
 * any time you change a collection's document shape, then register a
 * `{from_version, to_version, forward, backward}` migration via
 * `registerMigration` so existing documents can roll forward.
 */
const REGISTRY = Object.freeze({
  [COLLECTIONS.USERS]: {
    collection: COLLECTIONS.USERS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.PROFILES]: {
    collection: COLLECTIONS.PROFILES,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.OPPONENTS]: {
    collection: COLLECTIONS.OPPONENTS,
    // v2 — May 2026 "stuck on TOON id" fix:
    //   * coerce the literal "" stored in ``pulseCharacterId`` (the
    //     value rejected by the API ingest schema, but historically
    //     written by some early agent versions) to unset so the
    //     backfill cron's "missing or empty" filter matches them;
    //   * ensure ``pulseResolveAttemptedAt`` exists (Date|null) so
    //     the same backfill filter has a consistent shape.
    currentVersion: 2,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.GAMES]: {
    collection: COLLECTIONS.GAMES,
    // v2 — v0.4.3 storage trim: ``earlyBuildLog`` / ``oppEarlyBuildLog``
    // are dropped (derivable from full logs at read time).
    // v3 — v0.4.3 split: heavy fields move to ``game_details``.
    // v4 — v0.4.4 cutover: heavy-field columns are $unset on the
    //      ``games`` collection now that all readers fetch from the
    //      ``game_details`` collection (or from R2 when
    //      ``GAME_DETAILS_STORE=r2``).
    currentVersion: 4,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.GAME_DETAILS]: {
    collection: COLLECTIONS.GAME_DETAILS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.CUSTOM_BUILDS]: {
    collection: COLLECTIONS.CUSTOM_BUILDS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.DEVICE_PAIRINGS]: {
    collection: COLLECTIONS.DEVICE_PAIRINGS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.DEVICE_TOKENS]: {
    collection: COLLECTIONS.DEVICE_TOKENS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.OVERLAY_TOKENS]: {
    collection: COLLECTIONS.OVERLAY_TOKENS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  // Operational + ancillary collections. None of these have a
  // multi-version migration history yet — they all started life on
  // v1 and stay there until a future shape change. Listing them here
  // keeps the ``REGISTRY covers every COLLECTIONS entry`` invariant
  // green and makes future bumps a one-line edit instead of "add
  // entry + bump test threshold".
  [COLLECTIONS.ML_MODELS]: {
    collection: COLLECTIONS.ML_MODELS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.ML_JOBS]: {
    collection: COLLECTIONS.ML_JOBS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.IMPORT_JOBS]: {
    collection: COLLECTIONS.IMPORT_JOBS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.MACRO_JOBS]: {
    collection: COLLECTIONS.MACRO_JOBS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.AGENT_RELEASES]: {
    collection: COLLECTIONS.AGENT_RELEASES,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.COMMUNITY_BUILDS]: {
    collection: COLLECTIONS.COMMUNITY_BUILDS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.COMMUNITY_REPORTS]: {
    collection: COLLECTIONS.COMMUNITY_REPORTS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.USER_BACKUPS]: {
    collection: COLLECTIONS.USER_BACKUPS,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
  [COLLECTIONS.ARCADE_LEADERBOARD]: {
    collection: COLLECTIONS.ARCADE_LEADERBOARD,
    currentVersion: 1,
    versionKey: VERSION_KEY,
  },
});

/** @type {{collection:string,fromVersion:number,toVersion:number,forward:Function,backward:Function,description?:string}[]} */
const MIGRATIONS = [];

/**
 * Add a migration. Migration modules call this at import time; tests
 * call it to inject fixtures.
 *
 * @param {{
 *   collection: string,
 *   fromVersion: number,
 *   toVersion: number,
 *   forward: (doc: object) => object,
 *   backward: (doc: object) => object,
 *   description?: string
 * }} m
 */
function registerMigration(m) {
  if (
    !m ||
    typeof m.collection !== "string" ||
    typeof m.fromVersion !== "number" ||
    typeof m.toVersion !== "number" ||
    typeof m.forward !== "function" ||
    typeof m.backward !== "function"
  ) {
    throw new Error("registerMigration: malformed migration");
  }
  if (!REGISTRY[m.collection]) {
    throw new Error(`registerMigration: unknown collection '${m.collection}'`);
  }
  MIGRATIONS.push(m);
}

/** @param {string} collection */
function getSpec(collection) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, collection)
    ? REGISTRY[collection]
    : null;
}

/** @param {string} collection */
function expectedVersion(collection) {
  const s = getSpec(collection);
  return s ? s.currentVersion : null;
}

/**
 * Mutate `doc` in place to stamp `_schemaVersion = currentVersion`.
 * No-op for unknown collections or non-objects.
 *
 * @param {*} doc
 * @param {string} collection
 */
function stampVersion(doc, collection) {
  const spec = getSpec(collection);
  if (!spec) return doc;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  doc[spec.versionKey] = spec.currentVersion;
  return doc;
}

/** @param {*} doc @param {string} collection */
function getOnDiskVersion(doc, collection) {
  const spec = getSpec(collection);
  if (!spec) return null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const v = doc[spec.versionKey];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function _findStep(collection, fromV, toV) {
  for (const m of MIGRATIONS) {
    if (
      m.collection === collection &&
      m.fromVersion === fromV &&
      m.toVersion === toV
    ) {
      return m;
    }
  }
  return null;
}

function _chainForward(collection, fromV, toV) {
  if (fromV === toV) return [];
  if (toV < fromV) {
    throw new SchemaMigrationError(
      "_chainForward: from > to; use _chainBackward",
    );
  }
  const out = [];
  let cur = fromV;
  while (cur < toV) {
    const step = _findStep(collection, cur, cur + 1);
    if (!step) {
      throw new SchemaMigrationError(
        `missing forward migration for ${collection}: v${cur} -> v${cur + 1}`,
      );
    }
    out.push(step);
    cur += 1;
  }
  return out;
}

function _chainBackward(collection, fromV, toV) {
  if (fromV === toV) return [];
  if (toV > fromV) {
    throw new SchemaMigrationError(
      "_chainBackward: from < to; use _chainForward",
    );
  }
  const out = [];
  let cur = fromV;
  while (cur > toV) {
    const step = _findStep(collection, cur - 1, cur);
    if (!step) {
      throw new SchemaMigrationError(
        `missing backward migration for ${collection}: v${cur} -> v${cur - 1}`,
      );
    }
    out.push(step);
    cur -= 1;
  }
  return out;
}

/**
 * Apply migrations until `doc`'s version matches `targetVersion`
 * (defaults to the registry's currentVersion). Stamps the target
 * version on success.
 *
 * @param {*} doc
 * @param {string} collection
 * @param {{ targetVersion?: number }} [opts]
 */
function migrateDoc(doc, collection, opts) {
  const spec = getSpec(collection);
  if (!spec) return doc;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const target =
    opts && typeof opts.targetVersion === "number"
      ? opts.targetVersion
      : spec.currentVersion;
  let onDisk = getOnDiskVersion(doc, collection);
  if (onDisk === null) onDisk = 1;
  if (onDisk === target) {
    doc[spec.versionKey] = target;
    return doc;
  }
  let work = doc;
  if (onDisk < target) {
    for (const step of _chainForward(collection, onDisk, target)) {
      work = step.forward(work);
    }
  } else {
    for (const step of _chainBackward(collection, onDisk, target)) {
      work = step.backward(work);
    }
  }
  if (!work || typeof work !== "object" || Array.isArray(work)) {
    throw new SchemaMigrationError(
      `migration produced non-object for ${collection}`,
    );
  }
  work[spec.versionKey] = target;
  return work;
}

/**
 * @param {*} doc
 * @param {string} collection
 */
function assertNotTooNew(doc, collection) {
  const spec = getSpec(collection);
  if (!spec) return;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;
  const onDisk = getOnDiskVersion(doc, collection);
  if (onDisk === null) return;
  if (onDisk > spec.currentVersion) {
    throw new SchemaTooNewError(
      `${collection} doc on disk is v${onDisk} but this writer expects ` +
        `v${spec.currentVersion}; refusing to load.`,
    );
  }
}

module.exports = {
  REGISTRY,
  VERSION_KEY,
  SchemaMigrationError,
  SchemaTooNewError,
  registerMigration,
  getSpec,
  expectedVersion,
  stampVersion,
  getOnDiskVersion,
  migrateDoc,
  assertNotTooNew,
  _internals: { MIGRATIONS },
};
