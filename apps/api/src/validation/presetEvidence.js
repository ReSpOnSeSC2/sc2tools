"use strict";
/** Transient raw-clock classifier evidence. Never persisted on the slim game
 * row: it contains no player/owner IDs and only bounded SC2 event fields. */
const EVENT = {
  type: "object", additionalProperties: false, required: ["name", "type", "time"],
  properties: {
    name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]{0,79}$" },
    type: { type: "string", enum: ["building", "unit", "worker", "upgrade"] },
    time: { type: "number", minimum: 0, maximum: 86400 },
    subtype: { type: "string", enum: ["init", "born", "morph"] },
    hallucinated: { type: "boolean" }, is_proxy: { type: "boolean" },
    x: { type: "number", minimum: -100000, maximum: 100000 },
    y: { type: "number", minimum: -100000, maximum: 100000 },
  },
};
const AXIS = {
  type: "object", additionalProperties: false, required: ["custom", "baseline", "complete", "events"],
  properties: {
    custom: { type: "boolean" }, complete: { type: "boolean" },
    baseline: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 200 }] },
    events: { type: "array", maxItems: 5000, items: EVENT },
  },
};
const PRESET_EVIDENCE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "evaluatorVersion", "policyHash", "you", "opponent"],
  properties: {
    schemaVersion: { type: "integer", minimum: 1, maximum: 65535 },
    evaluatorVersion: { type: "integer", minimum: 1, maximum: 65535 },
    policyHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    you: AXIS, opponent: AXIS,
  },
};
module.exports = { PRESET_EVIDENCE_SCHEMA };
