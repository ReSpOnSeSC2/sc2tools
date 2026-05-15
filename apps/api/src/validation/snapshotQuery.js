"use strict";

const AjvModule = require("ajv");
const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;

const ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true });

/**
 * Query-string validation for the /v1/snapshots/* endpoints. Mirrors
 * the AJV-based contract in ``validation/gameRecord.js`` so the
 * routes can normalize + reject malformed input in one pass instead
 * of pepper-spraying type checks throughout the route handlers.
 *
 * The schemas are tuned for browser-emitted query strings (numbers
 * arrive as strings; ``coerceTypes`` lifts them) but reject values
 * outside the plausible range so a fat-finger MMR doesn't smuggle
 * a 99999 into the Mongo aggregation.
 */

const SCOPE_VALUES = ["mine", "community", "both"];

const cohortSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    build: { type: "string", maxLength: 200 },
    matchup: { type: "string", pattern: "^[PTZ]v[PTZ]$" },
    oppOpening: { type: "string", maxLength: 80 },
    mmrBucket: { type: "integer", minimum: 0, maximum: 9999 },
    mapId: { type: "string", maxLength: 200 },
    scope: { type: "string", enum: SCOPE_VALUES, default: "community" },
  },
};

const gameSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    scope: { type: "string", enum: SCOPE_VALUES, default: "community" },
    mmrBucket: { type: "integer", minimum: 0, maximum: 9999 },
    mapId: { type: "string", maxLength: 200 },
  },
};

const trendsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    lastN: { type: "integer", minimum: 1, maximum: 200, default: 20 },
    matchup: { type: "string", pattern: "^[PTZ]v[PTZ]$" },
    mmrBucket: { type: "integer", minimum: 0, maximum: 9999 },
  },
};

const neighborsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    anchorTick: { type: "integer", minimum: 0, maximum: 1200 },
    divergenceTick: { type: "integer", minimum: 0, maximum: 1200 },
    k: { type: "integer", minimum: 1, maximum: 10, default: 3 },
  },
  required: ["anchorTick"],
};

const buildsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    matchup: { type: "string", pattern: "^[PTZ]v[PTZ]$" },
    minSampleSize: { type: "integer", minimum: 1, maximum: 1000, default: 8 },
  },
};

const validateCohortQuery = ajv.compile(cohortSchema);
const validateGameQuery = ajv.compile(gameSchema);
const validateTrendsQuery = ajv.compile(trendsSchema);
const validateNeighborsQuery = ajv.compile(neighborsSchema);
const validateBuildsQuery = ajv.compile(buildsSchema);

/**
 * @template T
 * @param {(data: T) => boolean} validate
 * @param {T} data
 */
function runValidator(validate, data) {
  if (!validate(data)) {
    const errs = (validate.errors || []).map(
      /** @param {any} e */
      (e) => `${e.instancePath || "/"} ${e.message}`,
    );
    return { valid: false, errors: errs };
  }
  return { valid: true, value: data };
}

/** @param {Record<string, unknown>} q */
function parseCohortQuery(q) {
  const copy = pickKnown(q, ["build", "matchup", "oppOpening", "mmrBucket", "mapId", "scope"]);
  return runValidator(validateCohortQuery, copy);
}

/** @param {Record<string, unknown>} q */
function parseGameQuery(q) {
  const copy = pickKnown(q, ["scope", "mmrBucket", "mapId"]);
  return runValidator(validateGameQuery, copy);
}

/** @param {Record<string, unknown>} q */
function parseTrendsQuery(q) {
  const copy = pickKnown(q, ["lastN", "matchup", "mmrBucket"]);
  return runValidator(validateTrendsQuery, copy);
}

/** @param {Record<string, unknown>} q */
function parseNeighborsQuery(q) {
  const copy = pickKnown(q, ["anchorTick", "divergenceTick", "k"]);
  return runValidator(validateNeighborsQuery, copy);
}

/** @param {Record<string, unknown>} q */
function parseBuildsQuery(q) {
  const copy = pickKnown(q, ["matchup", "minSampleSize"]);
  return runValidator(validateBuildsQuery, copy);
}

/**
 * @param {Record<string, unknown>} src
 * @param {string[]} keys
 */
function pickKnown(src, keys) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!src || typeof src !== "object") return out;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

module.exports = {
  parseCohortQuery,
  parseGameQuery,
  parseTrendsQuery,
  parseNeighborsQuery,
  parseBuildsQuery,
  SCOPE_VALUES,
};
