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
    /**
     * Provenance fields populated when the build is captured from a
     * specific replay (Phase 6 "Save as new build" flow).
     */
    perspective: { type: "string", enum: ["you", "opponent"] },
    sourceGameId: { type: "string", maxLength: 200 },
    opponentRace: {
      type: "string",
      enum: ["Protoss", "Terran", "Zerg", "Random"],
    },
    /**
     * v3 rule schema — full SPA build editor parity. When `rules` is
     * present the agent's classifier evaluates them against parsed
     * events; if absent, the legacy `signature` array is used.
     */
    rules: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "time_lt"],
        properties: {
          type: {
            type: "string",
            enum: [
              "before",
              "not_before",
              "count_max",
              "count_exact",
              "count_min",
            ],
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            pattern: "^[A-Za-z][A-Za-z0-9]*$",
          },
          time_lt: { type: "integer", minimum: 1, maximum: 1800 },
          count: { type: "integer", minimum: 0, maximum: 200 },
        },
      },
    },
    /** Strategy notes — chips lists. */
    skillLevel: {
      type: ["string", "null"],
      enum: [
        "bronze",
        "silver",
        "gold",
        "platinum",
        "diamond",
        "master",
        "grandmaster",
        null,
      ],
    },
    winConditions: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 280 },
    },
    losesTo: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 280 },
    },
    transitionsInto: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 280 },
    },
    shareWithCommunity: { type: "boolean" },
    /** Schema version — server stores 3 for new editor saves. */
    schemaVersion: { type: "integer", minimum: 1, maximum: 10 },
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
