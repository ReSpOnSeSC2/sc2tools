// @ts-check
'use strict';

/**
 * SCHEMA-VERSION SINGLE SOURCE OF TRUTH (JS side)
 * ============================================================
 * Reads the canonical schema version straight from the JSON Schema
 * file's `properties.version.const` clause. Both Express (routes,
 * services) and Python (core/custom_builds.py via a parallel helper)
 * call into the same on-disk schema, so the two languages can never
 * drift the way they did during the engineering pass that landed the
 * Settings UI rework.
 *
 * Why this exists: incident #3 from ADR 0012. Python had
 * SCHEMA_VERSION = 2 hardcoded while JS had SCHEMA_VERSION = 3.
 * Python's _is_v1 heuristic flagged any v3 file with rules as v1,
 * destructively migrated it on every replay parse, and wiped the
 * user's custom builds. Centralising the version on the schema file
 * (which both languages already read) makes that bug class
 * impossible.
 *
 * Engineering preamble compliance:
 *   - Functions <= 30 lines.
 *   - No magic strings: schema filenames live in datastore.REGISTRY.
 *   - Narrow catches; no swallowed exceptions.
 *
 * Example:
 *   const { getSchemaVersion } = require('./schema-version');
 *   const v = getSchemaVersion('/abs/path/to/data', 'custom_builds');
 *   // v === 3
 */

const path = require('path');
const fs = require('fs');

const { REGISTRY } = require('./datastore');

/**
 * Read the canonical version constant from the named schema.
 *
 * Throws if the schema is missing or if it doesn't have a
 * `properties.version.const` clause -- both signal a code bug
 * (the schema MUST pin its own version) and should fail loudly,
 * not silently default.
 *
 * @param {string} dataDir Absolute path to data/.
 * @param {string} name    Document name from REGISTRY.
 * @returns {number} The integer version constant.
 */
function getSchemaVersion(dataDir, name) {
  if (typeof dataDir !== 'string' || !dataDir) {
    throw new TypeError('getSchemaVersion: dataDir required');
  }
  const entry = REGISTRY[name];
  if (!entry) {
    throw new Error('getSchemaVersion: unknown document ' + name);
  }
  const schemaPath = path.join(dataDir, entry.schema);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const versionProp = (schema.properties || {}).version || {};
  const constVal = versionProp.const;
  if (typeof constVal !== 'number' || !Number.isInteger(constVal)) {
    throw new Error(
      'getSchemaVersion: ' + name + ' schema lacks integer ' +
      'properties.version.const (got ' + JSON.stringify(constVal) + ')'
    );
  }
  return constVal;
}

/**
 * Return the schema versions for every registered document. Useful
 * for diagnostics + the cross-language consistency test.
 *
 * @param {string} dataDir
 * @returns {Object<string, number>}
 */
function getAllSchemaVersions(dataDir) {
  /** @type {{[name: string]: number}} */
  const out = {};
  for (const name of Object.keys(REGISTRY)) {
    out[name] = getSchemaVersion(dataDir, name);
  }
  return out;
}

module.exports = { getSchemaVersion, getAllSchemaVersions };
