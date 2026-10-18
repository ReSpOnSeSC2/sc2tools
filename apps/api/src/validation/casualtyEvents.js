"use strict";

const AjvModule = require("ajv");
const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;

// Exact tracker deaths, independent of sampled alive rosters. Absence means
// an older extraction; an empty array means verified zero casualties.
const CASUALTY_EVENTS_SCHEMA = {
  type: "array",
  maxItems: 20000,
  items: {
    type: "object",
    additionalProperties: true,
    required: ["time", "owner", "killer", "category", "name"],
    properties: {
      time: { type: "number", minimum: 0, maximum: 24 * 60 * 60 },
      owner: { enum: ["me", "opp"] },
      killer: { enum: ["me", "opp", null] },
      category: { enum: ["units", "buildings", "workers"] },
      name: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
};

// Shared by ingest, the macro recompute writer and public redaction so none
// can silently accept an unbounded or partial exact ledger.
const validateCasualtyEvents = new Ajv({ allErrors: false }).compile(CASUALTY_EVENTS_SCHEMA);

module.exports = { CASUALTY_EVENTS_SCHEMA, validateCasualtyEvents };
