"use strict";

const AjvModule = require("ajv");
const { REVIEWS } = require("../config/constants");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;

// Strict: unknown fields are a client bug, not something to drop quietly.
const ajv = new Ajv({ allErrors: true });

const REVIEW_TAGS = Object.freeze([
  "build_order",
  "macro",
  "scouting",
  "army_control",
  "decision_making",
  "micro",
  "specific_timing",
]);

const DESIRED_LEVELS = Object.freeze(["anyone", "my_league_or_higher", "masters_plus"]);
// Squads do not exist on the platform yet, so "squad only" is not
// offered; ``link`` is unlisted-but-readable-by-URL.
const VISIBILITIES = Object.freeze(["public", "link"]);
const ASKER_DISPLAY = Object.freeze(["named", "anonymous"]);

const TIME_SEC = { type: "number", minimum: 0, maximum: 86_400 };

const CREATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gameId", "question"],
  properties: {
    gameId: { type: "string", minLength: 1, maxLength: 200 },
    // Final bounds are enforced after cleanText (whitespace collapses).
    question: { type: "string", minLength: 1, maxLength: REVIEWS.QUESTION_MAX * 2 },
    tags: {
      type: "array",
      maxItems: REVIEW_TAGS.length,
      uniqueItems: true,
      items: { type: "string", enum: [...REVIEW_TAGS] },
    },
    timeRange: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["startSec", "endSec"],
      properties: { startSec: TIME_SEC, endSec: TIME_SEC },
    },
    desiredLevel: { type: "string", enum: [...DESIRED_LEVELS] },
    visibility: { type: "string", enum: [...VISIBILITIES] },
    askerDisplay: { type: "string", enum: [...ASKER_DISPLAY] },
  },
};

const MAP_POINT = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    // World cells. Ladder maps are at most 256×256; a small margin keeps
    // a pin placed on the very edge valid.
    x: { type: "number", minimum: -16, maximum: 512 },
    y: { type: "number", minimum: -16, maximum: 512 },
  },
};

const COMMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body", "gameTimeSec"],
  properties: {
    body: { type: "string", minLength: 1, maxLength: REVIEWS.COMMENT_MAX * 2 },
    gameTimeSec: TIME_SEC,
    endTimeSec: { type: ["number", "null"], minimum: 0, maximum: 86_400 },
    mapPoint: MAP_POINT,
    parentId: { type: ["string", "null"], minLength: 1, maxLength: 64 },
  },
};

const COMMENT_EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: COMMENT_SCHEMA.properties.body,
    gameTimeSec: TIME_SEC,
    endTimeSec: COMMENT_SCHEMA.properties.endTimeSec,
    mapPoint: MAP_POINT,
  },
};

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 80 },
    note: { type: "string", maxLength: 1000 },
  },
};

const validators = {
  create: ajv.compile(CREATE_SCHEMA),
  comment: ajv.compile(COMMENT_SCHEMA),
  commentEdit: ajv.compile(COMMENT_EDIT_SCHEMA),
  report: ajv.compile(REPORT_SCHEMA),
};

/**
 * @param {keyof typeof validators} kind
 * @param {unknown} raw
 * @returns {{valid: true, value: Record<string, any>} | {valid: false, errors: string[]}}
 */
function validateReviewInput(kind, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["body must be an object"] };
  }
  const validate = validators[kind];
  if (!validate(raw)) {
    const errors = (validate.errors || []).map(
      (/** @type {{instancePath?: string, message?: string}} */ e) =>
        `${e.instancePath || "body"} ${e.message || "is invalid"}`.trim(),
    );
    return { valid: false, errors };
  }
  return { valid: true, value: /** @type {Record<string, any>} */ (raw) };
}

module.exports = {
  REVIEW_TAGS,
  DESIRED_LEVELS,
  VISIBILITIES,
  ASKER_DISPLAY,
  validateReviewInput,
};
