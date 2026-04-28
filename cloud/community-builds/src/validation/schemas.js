"use strict";

const { LIMITS, RACES, VS_RACES, TIERS, ID_REGEX } = require("../constants");

const SIGNATURE_ITEM_SCHEMA = {
  type: "object",
  required: ["t", "what", "weight"],
  additionalProperties: false,
  properties: {
    t: { type: "number", minimum: LIMITS.SIGNATURE_T_MIN, maximum: LIMITS.SIGNATURE_T_MAX },
    what: { type: "string", minLength: 1, maxLength: LIMITS.SIGNATURE_WHAT_MAX },
    weight: { type: "number", minimum: LIMITS.WEIGHT_MIN, maximum: LIMITS.WEIGHT_MAX },
  },
};

const STRING_LIST_SCHEMA = {
  type: "array",
  maxItems: LIMITS.STRING_LIST_MAX_ITEMS,
  items: { type: "string", minLength: 1, maxLength: LIMITS.STRING_LIST_ITEM_MAX },
};

const TIER_SCHEMA = { type: ["string", "null"], enum: [...TIERS, null] };

const BUILD_BODY_SCHEMA = {
  type: "object",
  required: ["id", "name", "race", "vsRace", "signature"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: ID_REGEX.source },
    name: { type: "string", minLength: LIMITS.NAME_MIN, maxLength: LIMITS.NAME_MAX },
    race: { type: "string", enum: [...RACES] },
    vsRace: { type: "string", enum: [...VS_RACES] },
    tier: TIER_SCHEMA,
    description: { type: "string", maxLength: LIMITS.DESCRIPTION_MAX },
    winConditions: STRING_LIST_SCHEMA,
    losesTo: STRING_LIST_SCHEMA,
    transitionsInto: STRING_LIST_SCHEMA,
    signature: {
      type: "array",
      minItems: LIMITS.SIGNATURE_MIN_ITEMS,
      maxItems: LIMITS.SIGNATURE_MAX_ITEMS,
      items: SIGNATURE_ITEM_SCHEMA,
    },
    toleranceSec: {
      type: "integer",
      minimum: LIMITS.TOLERANCE_MIN,
      maximum: LIMITS.TOLERANCE_MAX,
    },
    minMatchScore: {
      type: "number",
      minimum: LIMITS.MIN_MATCH_MIN,
      maximum: LIMITS.MIN_MATCH_MAX,
    },
    authorDisplay: { type: "string", minLength: 1, maxLength: LIMITS.NAME_MAX },
  },
};

const VOTE_BODY_SCHEMA = {
  type: "object",
  required: ["vote"],
  additionalProperties: false,
  properties: { vote: { type: "integer", enum: [-1, 1] } },
};

const FLAG_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { reason: { type: "string", maxLength: LIMITS.DESCRIPTION_MAX } },
};

module.exports = {
  BUILD_BODY_SCHEMA,
  VOTE_BODY_SCHEMA,
  FLAG_BODY_SCHEMA,
  SIGNATURE_ITEM_SCHEMA,
};
