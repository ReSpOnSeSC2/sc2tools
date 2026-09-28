"use strict";

const AjvModule = require("ajv");
const { GUIDE_NOTE_MAX_CHARS } = require("../config/guides");
const {
  GUIDE_VIDEOS_PINNED_MAX,
  GUIDE_VIDEOS_HIDDEN_MAX,
} = require("../services/guideVideoSelect");
const { __internal: backfillInternal } = require("../jobs/guideSamplesBackfillJob");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;

/**
 * Request bodies of the admin guides API (routes/adminGuides.js):
 * coach's notes, per-guide video overrides, the samples backfill and the
 * video moderation calls. Strict: unknown fields are a client bug.
 */
const ajv = new Ajv({ allErrors: true });

/** YouTube video id (same grammar as services/guideVideoFeed.js). */
const VIDEO_ID_PATTERN = "^[A-Za-z0-9_-]{11}$";
const VIDEO_ID = { type: "string", pattern: VIDEO_ID_PATTERN };

const NOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    body: { type: "string", maxLength: GUIDE_NOTE_MAX_CHARS },
    videos: {
      type: "object",
      additionalProperties: false,
      properties: {
        pinned: { type: "array", maxItems: GUIDE_VIDEOS_PINNED_MAX, uniqueItems: true, items: VIDEO_ID },
        hidden: { type: "array", maxItems: GUIDE_VIDEOS_HIDDEN_MAX, uniqueItems: true, items: VIDEO_ID },
      },
    },
  },
};

const BACKFILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["start", "stop"] },
    days: { type: "integer", minimum: 1, maximum: backfillInternal.MAX_DAYS },
  },
};

const VIDEO_ADD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["youtubeId"],
  properties: { youtubeId: VIDEO_ID },
};

const VIDEO_PATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hidden"],
  properties: { hidden: { type: "boolean" } },
};

const validators = {
  note: ajv.compile(NOTE_SCHEMA),
  backfill: ajv.compile(BACKFILL_SCHEMA),
  videoAdd: ajv.compile(VIDEO_ADD_SCHEMA),
  videoPatch: ajv.compile(VIDEO_PATCH_SCHEMA),
};

/** @typedef {keyof typeof validators} GuideAdminInputKind */

/**
 * Validate one admin request body.
 *
 * Example: `validateGuideAdminInput("note", { body: "### Plan" })` →
 * `{ valid: true, value: { body: "### Plan" } }`.
 *
 * @param {GuideAdminInputKind} kind
 * @param {unknown} raw
 * @returns {{valid: true, value: Record<string, any>} | {valid: false, errors: string[]}}
 */
function validateGuideAdminInput(kind, raw) {
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

module.exports = { VIDEO_ID_PATTERN, validateGuideAdminInput };
