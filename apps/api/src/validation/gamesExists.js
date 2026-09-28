"use strict";

/**
 * Request schema for POST /v1/games/exists.
 *
 * Body: ``{ gameIds: string[] }`` with 1..LIMITS.GAMES_EXISTS_MAX_IDS ids,
 * each 1..LIMITS.GAME_ID_MAX_LENGTH characters. Nothing else is accepted,
 * so a client cannot smuggle a heavy payload through this cheap lookup.
 */

const AjvModule = require("ajv");
const { LIMITS } = require("../config/constants");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;

// Report the first violation only: a 500-item array of wrong types must not
// build 500 error objects for a request we are going to refuse anyway.
const ajv = new Ajv({ allErrors: false });
const MAX_REPORTED_ERRORS = 3;

const GAMES_EXISTS_SCHEMA = {
  type: "object",
  required: ["gameIds"],
  additionalProperties: false,
  properties: {
    gameIds: {
      type: "array",
      minItems: 1,
      maxItems: LIMITS.GAMES_EXISTS_MAX_IDS,
      items: {
        type: "string",
        minLength: 1,
        maxLength: LIMITS.GAME_ID_MAX_LENGTH,
      },
    },
  },
};

const validate = ajv.compile(GAMES_EXISTS_SCHEMA);

/**
 * Validate a games/exists request body (read-only; no coercion).
 *
 * Example:
 *   validateGamesExistsRequest({ gameIds: ["a"] })
 *   // -> { valid: true, value: { gameIds: ["a"] } }
 *   validateGamesExistsRequest({ gameIds: [] })
 *   // -> { valid: false, errors: ["/gameIds must NOT have fewer than 1 items"] }
 *
 * @param {unknown} raw
 * @returns {{valid: true, value: {gameIds: string[]}} | {valid: false, errors: string[]}}
 */
function validateGamesExistsRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["body must be an object"] };
  }
  if (!validate(raw)) {
    const errors = (validate.errors || []).slice(0, MAX_REPORTED_ERRORS).map(
      /** @param {{instancePath?: string, message?: string}} e */
      (e) => `${e.instancePath || "/"} ${e.message}`,
    );
    return { valid: false, errors };
  }
  // The compiled schema above guarantees this shape.
  const value = /** @type {{gameIds: string[]}} */ (raw);
  return { valid: true, value };
}

module.exports = { validateGamesExistsRequest, GAMES_EXISTS_SCHEMA };
