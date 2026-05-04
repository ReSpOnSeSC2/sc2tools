"use strict";

const AjvModule = require("ajv");
const addFormatsModule = require("ajv-formats");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const addFormats =
  /** @type {any} */ (addFormatsModule).default || addFormatsModule;

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing" });
addFormats(ajv);

const GAME_SCHEMA = {
  type: "object",
  required: ["gameId", "date", "result", "myRace", "map"],
  additionalProperties: true,
  properties: {
    gameId: { type: "string", minLength: 1, maxLength: 200 },
    date: { type: "string", format: "date-time" },
    result: { type: "string", enum: ["Victory", "Defeat", "Tie"] },
    myRace: { type: "string", minLength: 1, maxLength: 24 },
    myBuild: { type: "string", maxLength: 200 },
    map: { type: "string", minLength: 1, maxLength: 200 },
    durationSec: { type: "integer", minimum: 0, maximum: 24 * 60 * 60 },
    macroScore: { type: "number", minimum: 0, maximum: 100 },
    apm: { type: "number", minimum: 0, maximum: 5000 },
    spq: { type: "number", minimum: 0 },
    opponent: {
      type: "object",
      additionalProperties: true,
      properties: {
        pulseId: { type: "string", maxLength: 200 },
        displayName: { type: "string", maxLength: 80 },
        race: { type: "string", maxLength: 24 },
        mmr: { type: "integer", minimum: 0, maximum: 9999 },
        leagueId: { type: "integer", minimum: 0, maximum: 100 },
        opening: { type: "string", maxLength: 80 },
        strategy: { type: "string", maxLength: 200 },
      },
    },
    buildLog: { type: "array", maxItems: 5000 },
    earlyBuildLog: { type: "array", maxItems: 1000 },
    oppEarlyBuildLog: { type: "array", maxItems: 1000 },
    oppBuildLog: { type: "array", maxItems: 5000 },
  },
};

const validate = ajv.compile(GAME_SCHEMA);

/**
 * Validate + normalize one game record from the agent.
 *
 * @param {unknown} raw
 * @returns {{valid: true, value: object} | {valid: false, errors: string[]}}
 */
function validateGameRecord(raw) {
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

module.exports = { validateGameRecord };
