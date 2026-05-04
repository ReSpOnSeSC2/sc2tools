// @ts-check
/**
 * lib/schema_versioning.js -- Stage 6 of STAGE_DATA_INTEGRITY_ROADMAP.
 *
 * Mirrors core/schema_versioning.py byte-for-byte on the registry,
 * the version-key per file, and the Migration shape. The eager-import
 * pattern on the Python side is replaced with a static registration
 * array here (require() at module load time), which keeps the JS
 * migrations testable without triggering Node module-resolution
 * surprises.
 *
 * Public API:
 *   getSpec(basename) -> { basename, current_version, version_key }
 *   stampVersion(data, basename)              // mutates + returns
 *   getOnDiskVersion(data, basename) -> number | null
 *   migrateDict(data, basename, opts)         // forward / backward
 *   assertNotTooNew(data, basename)           // throws SchemaTooNewError
 */

'use strict';

class SchemaMigrationError extends Error {
  constructor(msg) { super(msg); this.name = 'SchemaMigrationError'; }
}
class SchemaTooNewError extends Error {
  constructor(msg) { super(msg); this.name = 'SchemaTooNewError'; }
}

const REGISTRY = Object.freeze({
  'MyOpponentHistory.json': {
    basename: 'MyOpponentHistory.json',
    current_version: 1,
    version_key: '_schema_version',
  },
  'meta_database.json': {
    basename: 'meta_database.json',
    current_version: 1,
    version_key: '_schema_version',
  },
  'custom_builds.json': {
    basename: 'custom_builds.json',
    current_version: 3,
    version_key: 'version',
  },
  'profile.json': {
    basename: 'profile.json',
    current_version: 1,
    version_key: '_schema_version',
  },
  'config.json': {
    basename: 'config.json',
    current_version: 1,
    version_key: '_schema_version',
  },
});

/** @type {{basename:string,from_version:number,to_version:number,forward:Function,backward:Function,description?:string}[]} */
const MIGRATIONS = [];

/**
 * Add a migration to the in-memory registry. Called by migration
 * modules at import time.
 * @param {object} m
 */
function registerMigration(m) {
  if (!m || typeof m.basename !== 'string'
      || typeof m.from_version !== 'number'
      || typeof m.to_version !== 'number'
      || typeof m.forward !== 'function'
      || typeof m.backward !== 'function') {
    throw new Error('registerMigration: malformed migration');
  }
  MIGRATIONS.push(m);
}

function getSpec(basename) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, basename)
    ? REGISTRY[basename] : null;
}

function expectedVersion(basename) {
  const s = getSpec(basename);
  return s ? s.current_version : null;
}

/**
 * Mutate `data` in place to carry the current schema version under
 * the registry's version_key. No-op for unrecognized basenames.
 * @param {*} data
 * @param {string} basename
 * @returns {*}
 */
function stampVersion(data, basename) {
  const spec = getSpec(basename);
  if (!spec) return data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  data[spec.version_key] = spec.current_version;
  return data;
}

function getOnDiskVersion(data, basename) {
  const spec = getSpec(basename);
  if (!spec) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const v = data[spec.version_key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function _findStep(basename, fromV, toV) {
  for (const m of MIGRATIONS) {
    if (m.basename === basename && m.from_version === fromV && m.to_version === toV) {
      return m;
    }
  }
  return null;
}

function _chainForward(basename, fromV, toV) {
  if (fromV === toV) return [];
  if (toV < fromV) {
    throw new SchemaMigrationError(
      '_chainForward: from > to; use _chainBackward');
  }
  const out = [];
  let cur = fromV;
  while (cur < toV) {
    const step = _findStep(basename, cur, cur + 1);
    if (!step) {
      throw new SchemaMigrationError(
        `missing forward migration for ${basename}: v${cur} -> v${cur + 1}`,
      );
    }
    out.push(step);
    cur += 1;
  }
  return out;
}

function _chainBackward(basename, fromV, toV) {
  if (fromV === toV) return [];
  if (toV > fromV) {
    throw new SchemaMigrationError(
      '_chainBackward: from < to; use _chainForward');
  }
  const out = [];
  let cur = fromV;
  while (cur > toV) {
    const step = _findStep(basename, cur - 1, cur);
    if (!step) {
      throw new SchemaMigrationError(
        `missing backward migration for ${basename}: v${cur} -> v${cur - 1}`,
      );
    }
    out.push(step);
    cur -= 1;
  }
  return out;
}

/**
 * Apply forward / backward migrations until `data`'s version matches
 * `targetVersion` (defaults to the registry's current_version).
 *
 * @param {*} data
 * @param {string} basename
 * @param {{ targetVersion?: number }} [opts]
 * @returns {*}
 */
function migrateDict(data, basename, opts) {
  const spec = getSpec(basename);
  if (!spec) return data;
  const target = opts && typeof opts.targetVersion === 'number'
    ? opts.targetVersion : spec.current_version;
  let onDisk = getOnDiskVersion(data, basename);
  if (onDisk === null) onDisk = 1;
  if (onDisk === target) {
    // Idempotent stamp under the registry's version_key.
    data[spec.version_key] = target;
    return data;
  }
  let work = data;
  if (onDisk < target) {
    for (const step of _chainForward(basename, onDisk, target)) {
      work = step.forward(work);
    }
  } else {
    for (const step of _chainBackward(basename, onDisk, target)) {
      work = step.backward(work);
    }
  }
  if (!work || typeof work !== 'object' || Array.isArray(work)) {
    throw new SchemaMigrationError(
      `migration produced non-object for ${basename}`,
    );
  }
  // Stamp with the *target* version, not the registry's current_version.
  // When target == current_version (the common case) this matches
  // stampVersion(); when an explicit target is passed (the downgrade
  // case), we honour it.
  work[spec.version_key] = target;
  return work;
}

function assertNotTooNew(data, basename) {
  const spec = getSpec(basename);
  if (!spec) return;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const onDisk = getOnDiskVersion(data, basename);
  if (onDisk === null) return;
  if (onDisk > spec.current_version) {
    throw new SchemaTooNewError(
      `${basename} on disk is v${onDisk} but this writer expects `
      + `v${spec.current_version}; refusing to load.`,
    );
  }
}

module.exports = {
  REGISTRY,
  SchemaMigrationError,
  SchemaTooNewError,
  registerMigration,
  getSpec,
  expectedVersion,
  stampVersion,
  getOnDiskVersion,
  migrateDict,
  assertNotTooNew,
  // For tests:
  _internals: { MIGRATIONS },
};
