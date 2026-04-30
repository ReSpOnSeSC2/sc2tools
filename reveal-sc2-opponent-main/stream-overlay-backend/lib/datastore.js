// @ts-check
'use strict';

const path = require('path');
const fs = require('fs');

// settings-pr1p: ajv ships its CommonJS export awkwardly; cast to any
// here so // @ts-check doesn't complain about the constructor/call.
const Ajv = /** @type {any} */ (require('ajv'));
const addFormats = /** @type {any} */ (require('ajv-formats'));

const atomicFs = require('./atomic-fs');

const REGISTRY = Object.freeze({
  profile: {
    file: 'profile.json',
    schema: 'profile.schema.json',
    defaults: () => null,
  },
  config: {
    file: 'config.json',
    schema: 'config.schema.json',
    defaults: () => null,
  },
  custom_builds: {
    file: 'custom_builds.json',
    schema: 'custom_builds.schema.json',
    // settings-pr1o: version is no longer hardcoded here. The actual
    // value gets injected at createDatastore() time from
    // properties.version.const in custom_builds.schema.json -- see
    // resolveDefaults(). Keeping the field with `null` so REGISTRY's
    // shape stays stable.
    defaults: () => ({ version: null, builds: [] }),
  },
});

class ValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'ValidationError';
    this.errors = Array.isArray(errors) ? errors : [];
  }
}

function nullLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function buildAjv() {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv;
}

function createDatastore(opts) {
  if (!opts || typeof opts.dataDir !== 'string' || !opts.dataDir) {
    throw new TypeError('createDatastore: dataDir required');
  }
  const dataDir = opts.dataDir;
  const logger = opts.logger || nullLogger();
  const ajv = buildAjv();
  const validators = compileValidators(ajv, dataDir);
  const versions = resolveDefaultVersions(dataDir);
  return buildApi(dataDir, logger, validators, versions);
}

function compileValidators(ajv, dataDir) {
  const out = {};
  for (const [name, entry] of Object.entries(REGISTRY)) {
    const schemaPath = path.join(dataDir, entry.schema);
    if (!fs.existsSync(schemaPath)) {
      throw new Error('datastore: missing schema ' + schemaPath);
    }
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    out[name] = ajv.compile(schema);
  }
  return out;
}

// settings-pr1o: pull each document's schema version into its
// default factory so callers never see a literal 3 hardcoded in JS.
// readDoc consults this when synthesising a fallback for missing
// documents.
function resolveDefaultVersions(dataDir) {
  const { getSchemaVersion } = require('./schema-version');
  const out = {};
  for (const name of Object.keys(REGISTRY)) {
    try { out[name] = getSchemaVersion(dataDir, name); }
    catch (_e) { out[name] = null; }
  }
  return out;
}

function applyVersionDefault(name, value, versions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  if (value.version != null) return value;
  const v = versions[name];
  if (typeof v !== 'number') return value;
  return Object.assign({}, value, { version: v });
}

function buildApi(dataDir, logger, validators, versions) {
  return {
    pathFor: (name) => filePathFor(dataDir, name),
    has: (name) => fs.existsSync(filePathFor(dataDir, name)),
    read: (name, options) => readDoc(dataDir, logger, validators, name, options, versions),
    write: (name, value) => writeDoc(dataDir, logger, validators, name, value),
    // settings-pr1o: expose for diagnostics + the cross-language test.
    versions: () => Object.assign({}, versions),
  };
}

function entryFor(name) {
  const entry = REGISTRY[name];
  if (!entry) throw new Error('datastore: unknown document ' + name);
  return entry;
}

function filePathFor(dataDir, name) {
  return path.join(dataDir, entryFor(name).file);
}

function readDoc(dataDir, logger, validators, name, options, versions) {
  const entry = entryFor(name);
  const filePath = path.join(dataDir, entry.file);
  let fallback = options && 'fallback' in options
    ? options.fallback : entry.defaults();
  // settings-pr1o: stamp the schema-derived version into the fallback
  // so callers never see a literal version: null leaking through.
  if (versions) fallback = applyVersionDefault(name, fallback, versions);
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const parsed = parseStrict(filePath, logger);
  if (parsed === undefined) {
    safeQuarantine(filePath, 'parse_error', logger);
    return fallback;
  }
  const validate = validators[name];
  if (!validate(parsed)) {
    logger.warn({ name, errors: validate.errors }, 'datastore.read.invalid');
    safeQuarantine(filePath, 'schema_invalid', logger);
    return fallback;
  }
  return parsed;
}

function parseStrict(filePath, logger) {
  try {
    let raw = fs.readFileSync(filePath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    raw = raw.replace(/[\u0000\s]+$/, '');
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ filePath, err: message }, 'datastore.parse_failed');
    return undefined;
  }
}

function safeQuarantine(filePath, reason, logger) {
  try {
    const dest = atomicFs.quarantineCorruptFile(filePath, reason);
    logger.warn({ from: filePath, to: dest, reason }, 'datastore.quarantined');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ filePath, err: message }, 'datastore.quarantine_failed');
  }
}

function writeDoc(dataDir, logger, validators, name, value) {
  const entry = entryFor(name);
  const validate = validators[name];
  if (!validate(value)) {
    throw new ValidationError(
      'datastore: ' + name + ' failed schema validation', validate.errors
    );
  }
  const filePath = path.join(dataDir, entry.file);
  atomicFs.atomicWriteJson(filePath, value);
  logger.info({ name, filePath }, 'datastore.write.ok');
}

module.exports = {
  createDatastore,
  ValidationError,
  REGISTRY,
};
