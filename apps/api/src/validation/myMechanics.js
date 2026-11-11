"use strict";

const AjvModule = require("ajv");
const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;

const count = { type: "integer", minimum: 0, maximum: 99999 };
const rate = { type: "number", minimum: 0, maximum: 5999940 };
/** @param {number} max @param {Record<string, object>} properties */
const slot = (max, properties) => ({
  type: "object",
  additionalProperties: false,
  required: ["slot", ...Object.keys(properties)],
  properties: { slot: { type: "integer", minimum: 0, maximum: max }, ...properties },
});
const metrics = {
  groups: { type: "array", maxItems: 10, items: slot(9, { sets: count, recalls: count, recallsPerMin: rate }) },
  camera: { type: "array", maxItems: 8, items: slot(7, { saves: count, returns: count, returnsPerMin: rate }) },
  selectionChangesPerMin: rate,
  queuedCommandShare: { type: "number", minimum: 0, maximum: 1 },
  cameraReturnsPerMin: rate,
  screenChangesPerMin: rate,
};
const seconds = { type: "integer", minimum: 0, maximum: 86400 };
const MY_MECHANICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["activeSeconds", "phases"],
  properties: {
    ...metrics,
    activeSeconds: { ...seconds, minimum: 1 },
    phases: {
      type: "array", maxItems: 3,
      items: {
        type: "object", additionalProperties: false, required: ["startSec", "endSec"],
        properties: { ...metrics, startSec: seconds, endSec: seconds },
      },
    },
  },
};

const validateMyMechanics = new Ajv({ allErrors: false }).compile(MY_MECHANICS_SCHEMA);
module.exports = { MY_MECHANICS_SCHEMA, validateMyMechanics };
