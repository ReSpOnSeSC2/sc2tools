"use strict";

const AjvModule = require("ajv");
const config = require("../config/referenceBuildOrder.json");
const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const limits = config.limits;
const LINE = "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]*$";
const REFERENCE_BUILD_ORDER_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["v", "steps", "source"],
  properties: {
    v: { const: config.version }, source: { enum: config.sources },
    sourceGameId: { type: "string", minLength: 1, maxLength: limits.gameIdChars, pattern: "^[A-Za-z0-9._:-]+$" },
    steps: { type: "array", maxItems: limits.steps, items: {
      type: "object", additionalProperties: false, required: ["t", "supply", "action"], properties: {
        t: { type: ["integer", "null"], minimum: 0, maximum: limits.seconds },
        supply: { type: ["number", "null"], minimum: 0, maximum: limits.supply },
        supplyApprox: { type: "boolean" },
        action: { type: "string", minLength: 1, maxLength: limits.actionChars, allOf: [{ pattern: LINE }, { pattern: "\\S" }] },
        note: { type: "string", maxLength: limits.noteChars, pattern: LINE },
      },
    } },
  },
});
const validate = new Ajv({ allErrors: true }).compile(REFERENCE_BUILD_ORDER_SCHEMA);
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
/** Keep one code point beyond the cap even for all-astral hostile strings.
 * @param {unknown} value @param {number} cap */
const boundedText = (value, cap) => typeof value === "string" ? value.slice(0, (cap + 1) * 2) : value;

/** Explicit nested projection before validation avoids duplicating an unknown
 * large child. One excess row remains so maxItems cannot silently truncate.
 * @param {unknown} raw @returns {unknown} */
function boundedReferenceBuildOrder(raw) {
  if (!object(raw)) return raw;
  /** @type {Record<string,unknown>} */ const out = {};
  for (const field of ["v", "source"]) if (Object.hasOwn(raw, field)) out[field] = raw[field];
  if (Object.hasOwn(raw, "sourceGameId")) out.sourceGameId = boundedText(raw.sourceGameId, limits.gameIdChars);
  if (Object.hasOwn(raw, "steps")) out.steps = Array.isArray(raw.steps) ? raw.steps.slice(0, limits.steps + 1).map(row => {
    if (!object(row)) return row;
    /** @type {Record<string,unknown>} */ const step = {};
    for (const field of ["t", "supply", "supplyApprox"]) if (Object.hasOwn(row, field)) step[field] = row[field];
    if (Object.hasOwn(row, "action")) step.action = boundedText(row.action, limits.actionChars);
    if (Object.hasOwn(row, "note")) step.note = boundedText(row.note, limits.noteChars);
    return step;
  }) : raw.steps;
  return out;
}

/** Unknown action names are display/reference text, never classification rules.
 * @param {unknown} raw */
function validateReferenceBuildOrder(raw) {
  const value = boundedReferenceBuildOrder(raw);
  return validate(value) ? { valid: true, value } : { valid: false,
    errors: (validate.errors || []).map(/** @param {any} error */ error => `${error.instancePath || "/"} ${error.message}`) };
}
module.exports = { REFERENCE_BUILD_ORDER_SCHEMA, boundedReferenceBuildOrder, validateReferenceBuildOrder, limits };
