"use strict";

const AjvModule = require("ajv");
const addFormatsModule = require("ajv-formats");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const addFormats =
  /** @type {any} */ (addFormatsModule).default || addFormatsModule;

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing" });
addFormats(ajv);

const BUILD_SCHEMA = {
  type: "object",
  required: ["slug", "name", "race"],
  additionalProperties: true,
  properties: {
    slug: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9._-]+$" },
    name: { type: "string", minLength: 1, maxLength: 120 },
    race: { type: "string", enum: ["Protoss", "Terran", "Zerg", "Random"] },
    vsRace: {
      type: "string",
      enum: ["Protoss", "Terran", "Zerg", "Random", "Any"],
    },
    description: { type: "string", maxLength: 4000 },
    signature: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          unit: { type: "string", maxLength: 80 },
          count: { type: "integer", minimum: 1, maximum: 200 },
          beforeSec: { type: "integer", minimum: 0, maximum: 24 * 60 * 60 },
        },
      },
    },
    notes: { type: "string", maxLength: 8000 },
    isPublic: { type: "boolean" },
  },
};

const validate = ajv.compile(BUILD_SCHEMA);

/**
 * @param {unknown} raw
 * @returns {{valid: true, value: object} | {valid: false, errors: string[]}}
 */
function validateCustomBuild(raw) {
  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["body must be an object"] };
  }
  const value = JSON.parse(JSON.stringify(raw));
  if (!validate(value)) {
    const errs = (validate.errors || []).map(
      /** @param {any} e */
      (e) => `${e.instancePath || "/"} ${e.message}`,
    );
    return { valid: false, errors: errs };
  }
  return { valid: true, value };
}

module.exports = { validateCustomBuild };
