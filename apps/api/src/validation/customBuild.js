"use strict";

const AjvModule = require("ajv");
const addFormatsModule = require("ajv-formats");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const addFormats =
  /** @type {any} */ (addFormatsModule).default || addFormatsModule;

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing" });
addFormats(ajv);

const SIGNATURE_MAX_ITEMS = 200;
const RULES_MAX_ITEMS = 30;
const STRATEGY_NOTES_MAX_ITEMS = 20;
const LEGACY_STEPS_MAX_ITEMS = 200;

// Keep this list in step with BUILD_SCHEMA. validateCustomBuild projects an
// untrusted JSON body through it before AJV runs so an unknown multi-megabyte
// object is never duplicated by the validation clone or persisted simply
// because a previous schema happened to allow additional properties.
const BUILD_FIELDS = Object.freeze([
  "slug",
  "name",
  "race",
  "vsRace",
  "matchup",
  "description",
  "signature",
  "steps",
  "notes",
  "isPublic",
  "perspective",
  "sourceGameId",
  "opponentRace",
  "rules",
  "skillLevel",
  "winConditions",
  "losesTo",
  "transitionsInto",
  "shareWithCommunity",
  "schemaVersion",
  "source",
]);

const BUILD_SCHEMA = {
  type: "object",
  required: ["slug", "name", "race"],
  additionalProperties: false,
  properties: {
    slug: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9._-]+$" },
    name: { type: "string", minLength: 1, maxLength: 120 },
    race: { type: "string", enum: ["Protoss", "Terran", "Zerg", "Random"] },
    vsRace: {
      type: "string",
      enum: ["Protoss", "Terran", "Zerg", "Random", "Any"],
    },
    // Legacy builds may carry an already-derived PvT-style label. New editor
    // saves derive it from race/vsRace, but retaining this bounded field keeps
    // old imports and community forks compatible.
    matchup: { type: "string", maxLength: 16 },
    description: { type: "string", maxLength: 4000 },
    signature: {
      type: "array",
      maxItems: SIGNATURE_MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          unit: { type: "string", maxLength: 80 },
          count: { type: "integer", minimum: 1, maximum: 200 },
          beforeSec: { type: "integer", minimum: 0, maximum: 24 * 60 * 60 },
        },
      },
    },
    // Read-only community pages still render this pre-signature build-order
    // shape. It was previously accepted only because the top-level schema was
    // open, which also made every unknown child unbounded.
    steps: {
      type: "array",
      maxItems: LEGACY_STEPS_MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          supply: { type: ["number", "null"], minimum: 0, maximum: 1000 },
          time: {
            anyOf: [
              { type: "string", maxLength: 20 },
              { type: "number", minimum: 0, maximum: 24 * 60 * 60 },
            ],
          },
          action: { type: "string", maxLength: 280 },
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
      maxItems: RULES_MAX_ITEMS,
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
      maxItems: STRATEGY_NOTES_MAX_ITEMS,
      items: { type: "string", maxLength: 280 },
    },
    losesTo: {
      type: "array",
      maxItems: STRATEGY_NOTES_MAX_ITEMS,
      items: { type: "string", maxLength: 280 },
    },
    transitionsInto: {
      type: "array",
      maxItems: STRATEGY_NOTES_MAX_ITEMS,
      items: { type: "string", maxLength: 280 },
    },
    shareWithCommunity: { type: "boolean" },
    /** Schema version — server stores 3 for new editor saves. */
    schemaVersion: { type: "integer", minimum: 1, maximum: 10 },
    /**
     * Provenance label. ``manual`` for hand-authored saves (default),
     * ``import`` reserved for future bulk-import flows. ``auto-classify``
     * is a legacy value kept so previously-saved builds still validate;
     * nothing produces it anymore. This field is metadata ONLY — read
     * paths (list / stats / publish / community) must NEVER gate on it.
     */
    source: { type: "string", enum: ["manual", "auto-classify", "import"] },
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
  const value = boundedBuildClone(/** @type {Record<string, unknown>} */ (raw));
  if (!validate(value)) {
    const errs = (validate.errors || []).map(
      /** @param {any} e */
      (e) => `${e.instancePath || "/"} ${e.message}`,
    );
    return { valid: false, errors: errs };
  }
  return { valid: true, value };
}

/**
 * Copy only the persisted contract and at most one item beyond each array's
 * maximum. The extra item lets AJV report `maxItems` while avoiding a second
 * unbounded allocation for a hostile/legacy in-memory value. Nested objects
 * are projected to their known leaves, so a giant unknown child is dropped
 * before validation rather than after a JSON stringify/parse round trip.
 *
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function boundedBuildClone(raw) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const field of BUILD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      out[field] = raw[field];
    }
  }
  out.signature = boundedObjectArray(
    raw.signature,
    SIGNATURE_MAX_ITEMS,
    ["unit", "count", "beforeSec"],
  );
  out.rules = boundedObjectArray(
    raw.rules,
    RULES_MAX_ITEMS,
    ["type", "name", "time_lt", "count"],
  );
  out.steps = boundedObjectArray(
    raw.steps,
    LEGACY_STEPS_MAX_ITEMS,
    ["supply", "time", "action"],
  );
  for (const field of ["winConditions", "losesTo", "transitionsInto"]) {
    out[field] = boundedScalarArray(raw[field], STRATEGY_NOTES_MAX_ITEMS);
  }
  // Do not manufacture optional fields that were absent from the request.
  for (const field of [
    "signature",
    "rules",
    "steps",
    "winConditions",
    "losesTo",
    "transitionsInto",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) delete out[field];
  }
  return out;
}

/** @param {unknown} value @param {number} max */
function boundedScalarArray(value, max) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, max + 1);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @param {readonly string[]} fields
 */
function boundedObjectArray(value, max, fields) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, max + 1).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(item, field)) {
        out[field] = item[field];
      }
    }
    return out;
  });
}

module.exports = {
  validateCustomBuild,
  SIGNATURE_MAX_ITEMS,
  RULES_MAX_ITEMS,
  STRATEGY_NOTES_MAX_ITEMS,
  LEGACY_STEPS_MAX_ITEMS,
};
