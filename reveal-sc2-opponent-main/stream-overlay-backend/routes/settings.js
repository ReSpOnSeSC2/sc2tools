/**
 * SETTINGS ROUTER
 * ============================================================
 * Express sub-router that owns the two installation-level JSON
 * files at the repo root:
 *
 *   data/profile.json   -- per-user identity (battle_tag, ids, race)
 *   data/config.json    -- per-installation settings (paths, engine,
 *                          overlay, telemetry, ui)
 *
 * Schemas live at data/profile.schema.json and data/config.schema.json
 * and are enforced with ajv on every write. PATCH does a structural
 * deepMerge into whatever is currently on disk and re-validates the
 * merged result.
 *
 * The router is built by `createSettingsRouter({ dataDir })` so tests
 * can point it at a tmp directory without touching real user data.
 *
 * Atomic write contract: all mutations write to <file>.tmp, fsync the
 * tmp fd, then rename over the target. Mirrors persistMetaDb in
 * analyzer.js.
 *
 * No PII is ever logged. The router logs only paths and operation
 * names (`settings.put profile`, etc.).
 *
 * Example:
 *   const { createSettingsRouter } = require('./routes/settings');
 *   app.use(createSettingsRouter({ dataDir: '/abs/path/to/data' }));
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const PROFILE_FILE = 'profile.json';
const CONFIG_FILE = 'config.json';
const PROFILE_SCHEMA_FILE = 'profile.schema.json';
const CONFIG_SCHEMA_FILE = 'config.schema.json';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL = 500;
const NOT_INITIALIZED = 'not_initialized';

/**
 * Read a JSON file from disk, stripping a leading BOM if present.
 *
 * Example:
 *   const obj = readJsonStripBom('/data/profile.json');
 *
 * @param {string} filePath Absolute path.
 * @returns {object} Parsed JSON.
 */
function readJsonStripBom(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

/**
 * Read a JSON file or return null when the file is missing.
 *
 * Example:
 *   const cur = readJsonOrNull('/data/config.json'); // null first run
 *
 * @param {string} filePath Absolute path.
 * @returns {object|null}
 */
function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJsonStripBom(filePath);
}

/**
 * Atomically write a JSON object: write→fsync→rename.
 *
 * Mirrors persistMetaDb in analyzer.js. Crash-safe: a torn write
 * never replaces the live file because rename is atomic on POSIX
 * and on NTFS within the same volume.
 *
 * Example:
 *   atomicWriteJson('/data/profile.json', { version: 1, ... });
 *
 * @param {string} filePath Absolute path of the target.
 * @param {object} obj Serializable JSON value.
 * @returns {void}
 */
function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  const json = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/**
 * Recursive merge for PATCH. Plain objects merge; arrays and
 * primitives in `src` replace those in `target`. Null in `src`
 * sets the key to null. Never mutates inputs.
 *
 * Example:
 *   deepMerge({ a: { b: 1 } }, { a: { c: 2 } }) === { a: { b: 1, c: 2 } }
 *
 * @param {object} target Current value.
 * @param {object} src Patch payload.
 * @returns {object} Merged copy.
 */
function deepMerge(target, src) {
  if (!isPlainObject(target) || !isPlainObject(src)) return clone(src);
  const out = { ...target };
  for (const key of Object.keys(src)) {
    const a = target[key];
    const b = src[key];
    out[key] = isPlainObject(a) && isPlainObject(b) ? deepMerge(a, b) : clone(b);
  }
  return out;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Convert ajv error objects into a flat, log-safe shape.
 *
 * Example:
 *   formatErrors(validate.errors)
 *     // => [{ path: '/battlenet/region', message: 'must be equal to one of...' }]
 *
 * @param {Array<object>|null|undefined} errors ajv error array.
 * @returns {Array<{path: string, message: string}>}
 */
function formatErrors(errors) {
  if (!Array.isArray(errors)) return [];
  return errors.map((err) => ({
    path: err.instancePath || err.schemaPath || '',
    message: err.message || 'invalid',
  }));
}

/**
 * Build an ajv instance with formats enabled. One per router so the
 * compiled schema cache is isolated.
 *
 * Example:
 *   const ajv = buildAjv();
 *   const validate = ajv.compile(schema);
 *
 * @returns {import('ajv').default} ajv instance.
 */
function buildAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Compile the two schemas at router construction time. Throws if a
 * schema file is missing or malformed -- that's a deploy-time bug,
 * not a runtime one.
 *
 * Example:
 *   const validators = compileValidators(ajv, '/data');
 *
 * @param {import('ajv').default} ajv ajv instance.
 * @param {string} dataDir Directory containing *.schema.json files.
 * @returns {{ profile: Function, config: Function }}
 */
function compileValidators(ajv, dataDir) {
  const profileSchema = readJsonStripBom(path.join(dataDir, PROFILE_SCHEMA_FILE));
  const configSchema = readJsonStripBom(path.join(dataDir, CONFIG_SCHEMA_FILE));
  return {
    profile: ajv.compile(profileSchema),
    config: ajv.compile(configSchema),
  };
}

/**
 * Build the per-document descriptor used by every endpoint handler.
 *
 * @param {string} dataDir Absolute data directory.
 * @param {{ profile: Function, config: Function }} validators Compiled.
 * @returns {{ profile: object, config: object }} Spec map.
 */
function buildSpecs(dataDir, validators) {
  return {
    profile: {
      name: 'profile',
      filePath: path.join(dataDir, PROFILE_FILE),
      validate: validators.profile,
    },
    config: {
      name: 'config',
      filePath: path.join(dataDir, CONFIG_FILE),
      validate: validators.config,
    },
  };
}

// --------------------------------------------------------------
// HANDLERS
// --------------------------------------------------------------

function handleGet(spec) {
  return (_req, res) => {
    const data = readJsonOrNull(spec.filePath);
    if (data === null) {
      return res.status(HTTP_NOT_FOUND).json({ error: NOT_INITIALIZED });
    }
    return res.status(HTTP_OK).json({ [spec.name]: data });
  };
}

function handlePut(spec) {
  return (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) {
      return res.status(HTTP_BAD_REQUEST).json({
        error: 'invalid_body',
        errors: [{ path: '', message: 'request body must be a JSON object' }],
      });
    }
    if (!spec.validate(body)) {
      return res.status(HTTP_BAD_REQUEST).json({
        error: 'validation_failed',
        errors: formatErrors(spec.validate.errors),
      });
    }
    return writeAndRespond(spec, body, res);
  };
}

function handlePatch(spec) {
  return (req, res) => {
    const patch = req.body;
    if (!isPlainObject(patch)) {
      return res.status(HTTP_BAD_REQUEST).json({
        error: 'invalid_body',
        errors: [{ path: '', message: 'request body must be a JSON object' }],
      });
    }
    const current = readJsonOrNull(spec.filePath) || {};
    const merged = deepMerge(current, patch);
    if (!spec.validate(merged)) {
      return res.status(HTTP_BAD_REQUEST).json({
        error: 'validation_failed',
        errors: formatErrors(spec.validate.errors),
      });
    }
    return writeAndRespond(spec, merged, res);
  };
}

function writeAndRespond(spec, value, res) {
  try {
    atomicWriteJson(spec.filePath, value);
  } catch (err) {
    console.error(`[settings] write failed (${spec.name}): ${err.message}`);
    return res.status(HTTP_INTERNAL).json({ error: 'write_failed' });
  }
  console.log(`[settings] ${spec.name} written`);
  return res.status(HTTP_OK).json({ [spec.name]: value });
}

function handleValidate(spec) {
  return (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) {
      return res.status(HTTP_OK).json({
        ok: false,
        errors: [{ path: '', message: 'request body must be a JSON object' }],
      });
    }
    const ok = !!spec.validate(body);
    return res.status(HTTP_OK).json({
      ok,
      errors: ok ? [] : formatErrors(spec.validate.errors),
    });
  };
}

function handleExists(spec) {
  return (_req, res) => {
    res.status(HTTP_OK).json({ exists: fs.existsSync(spec.filePath) });
  };
}

/**
 * Wire all six route patterns for one document spec.
 *
 * @param {express.Router} router Router being decorated.
 * @param {string} prefix URL prefix, e.g. '/api/profile'.
 * @param {object} spec From buildSpecs.
 * @returns {void}
 */
function mountSpec(router, prefix, spec) {
  router.get(`${prefix}/exists`, handleExists(spec));
  router.post(`${prefix}/validate`, handleValidate(spec));
  router.get(prefix, handleGet(spec));
  router.put(prefix, handlePut(spec));
  router.patch(prefix, handlePatch(spec));
}

/**
 * Build the settings sub-router. Call once at startup.
 *
 * Example:
 *   app.use(createSettingsRouter({ dataDir: path.join(ROOT, 'data') }));
 *
 * @param {{ dataDir: string }} opts
 *   `dataDir` -- absolute directory holding profile.json, config.json,
 *   and their *.schema.json siblings.
 * @returns {express.Router}
 */
function createSettingsRouter(opts) {
  if (!opts || typeof opts.dataDir !== 'string' || !opts.dataDir) {
    throw new Error('createSettingsRouter requires opts.dataDir');
  }
  const ajv = buildAjv();
  const validators = compileValidators(ajv, opts.dataDir);
  const specs = buildSpecs(opts.dataDir, validators);
  const router = express.Router();
  mountSpec(router, '/api/profile', specs.profile);
  mountSpec(router, '/api/config', specs.config);
  return router;
}

module.exports = {
  createSettingsRouter,
  // exported for unit tests / shared use
  atomicWriteJson,
  deepMerge,
  formatErrors,
  isPlainObject,
};
