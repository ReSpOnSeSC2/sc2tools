"use strict";

const AjvModule = require("ajv");

const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;

// Strict: reject unknown fields outright. Settings UI knows the
// schema, and silently dropping properties hides client bugs.
const ajv = new Ajv({ allErrors: true });

const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    // BattleTag has the form Name#1234 with a unicode-friendly handle.
    // Empty string clears the field, so accept that too.
    battleTag: {
      type: ["string", "null"],
      maxLength: 80,
    },
    // SC2Pulse character ids are numeric, but we keep this loose since
    // the agent occasionally falls back to a toon handle (slash-separated).
    pulseId: {
      type: ["string", "null"],
      maxLength: 64,
    },
    region: {
      type: ["string", "null"],
      enum: ["", "us", "eu", "kr", "cn", null],
    },
    preferredRace: {
      type: ["string", "null"],
      enum: ["", "Terran", "Zerg", "Protoss", "Random", null],
    },
    displayName: {
      type: ["string", "null"],
      maxLength: 80,
    },
    // Sticky "last known MMR" — captured by the agent from each
    // successfully-parsed replay and pinged to the cloud here. The
    // session widget falls back to this when no game in the user's
    // history carries `myMmr`, so streamers who haven't re-synced
    // (and whose existing rows pre-date the v0.5.6 extraction fix)
    // still see a number on the overlay until their next ranked
    // game lands. Range mirrors the games-row schema so a pasted
    // value can't poison the resolver. ``lastKnownMmrAt`` is an ISO
    // 8601 timestamp; ``lastKnownMmrRegion`` is the short region
    // label (NA/EU/KR/CN/SEA) the agent inferred from the toon
    // handle byte at extraction time.
    lastKnownMmr: {
      type: ["integer", "null"],
      minimum: 500,
      maximum: 9999,
    },
    lastKnownMmrAt: {
      type: ["string", "null"],
      maxLength: 40,
    },
    lastKnownMmrRegion: {
      type: ["string", "null"],
      maxLength: 8,
    },
  },
};

const validate = ajv.compile(PROFILE_SCHEMA);

/**
 * Validate the request body for PUT /v1/me/profile. The settings UI
 * sends partial updates (any field absent means "leave alone"); for
 * this endpoint we treat absent === null === "" as "clear the field".
 *
 * @param {unknown} raw
 * @returns {{valid: true, value: object} | {valid: false, errors: string[]}}
 */
function validateProfile(raw) {
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

module.exports = { validateProfile };
