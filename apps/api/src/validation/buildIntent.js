"use strict";

/**
 * Request validation for the build check-in routes (routes/buildIntents.js).
 *
 * Bodies are strict (unknown fields are refused). Errors map to the
 * contract's codes: an unknown ``action`` is ``invalid_action``, a
 * non-string ``notes`` is ``invalid_notes``, a malformed ``buildKey`` is
 * ``unknown_build``, a malformed ``opponentBuildKey`` (a game PUT's
 * opponent correction: a key, or null to clear it) is
 * ``unknown_opponent_build``; any other shape problem, including the
 * ``opponent`` action without ``opponentBuildKey``, is ``invalid_request``.
 * The notes length limit (1000 after sanitising) is enforced by the
 * services.
 */

const AjvModule = require("ajv");
const { BUILD_INTENT } = require("../config/constants");
const { MATCHUP_RE } = require("../services/buildIntentShape");
const { isValidGameKey } = require("../services/buildIntentCommon");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const ajv = new Ajv({ allErrors: false });

const LIVE_ACTIONS = Object.freeze(["register", "declare", "undeclare", "release", "postgame"]);
const GAME_ACTIONS = Object.freeze(["confirm", "skip", "defer", "notes", "opponent"]);
const OPTION_SIDES = Object.freeze(["you", "opponent"]);
// Raw notes may carry control characters that sanitising strips; anything
// this long cannot sanitise to <= 1000 characters of text worth keeping.
const RAW_NOTES_MAX_LENGTH = 4000;
const BUILD_KEY_MAX_LENGTH = 200;
const RACE_MAX_LENGTH = 24;

const LIVE_BODY_SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [...LIVE_ACTIONS] },
    buildKey: { type: "string", minLength: 1, maxLength: BUILD_KEY_MAX_LENGTH },
    notes: { type: "string", maxLength: RAW_NOTES_MAX_LENGTH },
    skip: { type: "boolean" },
    myRace: { type: ["string", "null"], maxLength: RACE_MAX_LENGTH },
    oppRace: { type: ["string", "null"], maxLength: RACE_MAX_LENGTH },
    oppName: { type: ["string", "null"], maxLength: BUILD_INTENT.OPP_NAME_MAX_LENGTH * 2 },
    // ``register``: the live phase the card registered in.
    phase: { type: "string", enum: ["match_loading", "match_started"] },
  },
};

const GAME_BODY_SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [...GAME_ACTIONS] },
    buildKey: { type: "string", minLength: 1, maxLength: BUILD_KEY_MAX_LENGTH },
    notes: { type: "string", maxLength: RAW_NOTES_MAX_LENGTH },
    opponentBuildKey: { type: ["string", "null"], minLength: 1, maxLength: BUILD_KEY_MAX_LENGTH },
  },
};

const validateLive = ajv.compile(LIVE_BODY_SCHEMA);
const validateGame = ajv.compile(GAME_BODY_SCHEMA);

/**
 * @template T
 * @typedef {{ valid: true, value: T } | { valid: false, code: string, message: string }} Validated
 */

/**
 * @param {unknown} raw
 * @param {ReadonlyArray<string>} actions
 * @param {(value: unknown) => boolean} validate compiled schema
 * @param {(body: Record<string, unknown>) => Validated<Record<string, any>> | null} [check]
 *   body-specific check run before the schema (null = passed)
 * @returns {Validated<Record<string, any>>}
 */
function validateBody(raw, actions, validate, check) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, code: "invalid_action", message: "Body must be an object with an action." };
  }
  const body = /** @type {Record<string, unknown>} */ (raw);
  if (typeof body.action !== "string" || !actions.includes(body.action)) {
    return { valid: false, code: "invalid_action", message: "Unknown action." };
  }
  if (body.notes !== undefined
    && (typeof body.notes !== "string" || body.notes.length > RAW_NOTES_MAX_LENGTH)) {
    return { valid: false, code: "invalid_notes", message: "Notes are limited to 1000 characters." };
  }
  if (body.buildKey !== undefined
    && (typeof body.buildKey !== "string" || body.buildKey.length === 0
      || body.buildKey.length > BUILD_KEY_MAX_LENGTH)) {
    return { valid: false, code: "unknown_build", message: "Unknown build." };
  }
  const failed = check ? check(body) : null;
  if (failed) return failed;
  if (!validate(body)) {
    return { valid: false, code: "invalid_request", message: "Invalid request body." };
  }
  return { valid: true, value: body };
}

/**
 * Body of ``PUT /v1/build-intents/live/:gameKey``.
 * @param {unknown} raw
 */
function validateLiveIntentBody(raw) {
  return validateBody(raw, LIVE_ACTIONS, validateLive);
}

/**
 * Body of ``PUT /v1/games/:gameId/build-intent``.
 * @param {unknown} raw
 * @returns {Validated<Record<string, any>>}
 */
function validateGameIntentBody(raw) {
  return validateBody(raw, GAME_ACTIONS, validateGame, checkOpponentKey);
}

/**
 * ``opponentBuildKey``: a key string, or null to clear the correction;
 * required by the ``opponent`` action.
 * @param {Record<string, unknown>} body
 * @returns {Validated<Record<string, any>> | null}
 */
function checkOpponentKey(body) {
  const key = body.opponentBuildKey;
  if (key !== undefined && key !== null
    && (typeof key !== "string" || key.length === 0 || key.length > BUILD_KEY_MAX_LENGTH)) {
    return { valid: false, code: "unknown_opponent_build", message: "Unknown opponent build." };
  }
  if (body.action === "opponent" && key === undefined) {
    return { valid: false, code: "invalid_request", message: "The opponent action needs opponentBuildKey." };
  }
  return null;
}

/**
 * @param {unknown} raw ``?matchup=``
 * @returns {string|null} "PvZ" form, or null when invalid
 */
function parseMatchupParam(raw) {
  return typeof raw === "string" && MATCHUP_RE.test(raw) ? raw : null;
}

/**
 * ``?side=`` for the options route: "you" (default) or "opponent".
 * @param {unknown} raw
 * @returns {"you"|"opponent"|null} null when invalid
 */
function parseSideParam(raw) {
  if (raw === undefined) return "you";
  return typeof raw === "string" && OPTION_SIDES.includes(raw)
    ? /** @type {"you"|"opponent"} */ (raw)
    : null;
}

/**
 * ``?limit=`` for the pending queue: 1..25, default 10.
 * @param {unknown} raw
 * @returns {number}
 */
function parsePendingLimit(raw) {
  const n = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return BUILD_INTENT.PENDING_LIMIT_DEFAULT;
  return Math.min(BUILD_INTENT.PENDING_LIMIT_MAX, Math.max(1, n));
}

module.exports = {
  LIVE_ACTIONS,
  GAME_ACTIONS,
  validateLiveIntentBody,
  validateGameIntentBody,
  parseMatchupParam,
  parseSideParam,
  parsePendingLimit,
  isValidGameKey,
};
