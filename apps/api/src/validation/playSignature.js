"use strict";

const AjvModule = require("ajv");
const Ajv = /** @type {any} */ (AjvModule).default || AjvModule;
const { groupMembershipFields, cameraSchema, validV3Semantics } = require("./playSignatureV3");

/** @param {number} maximum @param {number} [minimum] */
const integer = (maximum, minimum = 0) => ({ type: "integer", minimum, maximum });
/** @param {Record<string, any>} properties @param {string[]} required */
const object = (properties, required) => ({
  type: "object", additionalProperties: false, properties, required,
});
/** @param {Record<string, any>} items @param {number} maximum @param {number} [minimum] */
const array = (items, maximum, minimum = 0) => ({
  type: "array", items, minItems: minimum, maxItems: maximum,
});
const count = integer(99999);
const slotCount = integer(9999);
const seconds = integer(600);
const histogram = array(count, 6, 6);
const name = { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" };
const ability = object({ name, count: integer(99999, 1) }, ["name", "count"]);
const operations = {
  slot: integer(9), set: slotCount, add: slotCount, recall: slotCount,
};
const richOperations = {
  ...operations, stealSet: slotCount, stealAdd: slotCount, clear: slotCount,
};
const phaseWindow = { startSec: { enum: [0, 120, 300] }, endSec: integer(600, 1) };
const slotV1 = object({ ...operations, doubleTap: slotCount }, [
  "slot", "set", "add", "recall", "doubleTap",
]);
const slotV2 = object({
  ...richOperations, doubleTap: slotCount, firstUseSec: seconds,
  recallIntervals: histogram,
}, slotV1.required);
const controlV1 = object({
  events: integer(99999, 1), activeSeconds: integer(600, 1),
  slots: array(slotV1, 10, 1),
  transitions: array(object({ from: integer(9), to: integer(9), count: integer(9999, 1) }, [
    "from", "to", "count",
  ]), 12),
}, ["events", "activeSeconds", "slots"]);
const controlV2 = object({
  ...controlV1.properties, slots: array(slotV2, 10, 1), recallIntervals: histogram,
  phases: array(object({
    ...phaseWindow, events: count,
    slots: array(object(richOperations, Object.keys(richOperations)), 10),
  }, ["startSec", "endSec", "events", "slots"]), 3),
  commandFollowup: array(object({
    slot: integer(9), commands: integer(99999, 1), queued: count, rapidRepeat: count,
    abilities: array(ability, 6),
  }, ["slot", "commands", "queued", "rapidRepeat"]), 10),
}, controlV1.required);
const actions = object({
  activeSeconds: integer(600, 1), events: integer(99999, 1),
  commands: count, selectionChanges: count, cameraMoves: count,
  queuedCommands: count, repeatCommands: count,
  targetCommands: object({ none: count, point: count, unit: count, data: count }, [
    "none", "point", "unit", "data",
  ]),
  actionIntervals: histogram, cameraIntervals: histogram,
  phases: array(object({
    ...phaseWindow, commands: count, selectionChanges: count, cameraMoves: count,
    controlGroups: count,
  }, ["startSec", "endSec", "commands", "selectionChanges", "cameraMoves", "controlGroups"]), 3),
  abilityUsage: array(ability, 12),
}, ["activeSeconds", "events", "commands", "selectionChanges", "cameraMoves", "queuedCommands", "repeatCommands"]);
const build = object({ milestones: array(object({
  atSec: seconds, name,
}, ["atSec", "name"]), 18, 1) }, ["milestones"]);
const v1 = {
  ...object({ version: { const: 1 }, windowSec: integer(600, 1), controlGroups: controlV1, build }, [
    "version", "windowSec",
  ]),
  anyOf: [{ required: ["controlGroups"] }, { required: ["build"] }],
};
const v2 = {
  ...object({ version: { const: 2 }, windowSec: integer(600, 1), controlGroups: controlV2, actions, build }, [
    "version", "windowSec",
  ]),
  anyOf: [{ required: ["controlGroups"] }, { required: ["actions"] }, { required: ["build"] }],
};
const v3 = {
  ...object({ ...v2.properties, version: { const: 3 }, camera: cameraSchema,
    controlGroups: object({ ...controlV2.properties, ...groupMembershipFields }, controlV2.required),
  }, ["version", "windowSec"]),
  anyOf: [...v2.anyOf, { required: ["camera"] }],
};
const PLAY_SIGNATURE_SCHEMA = { anyOf: [v1, v2, v3] };
const validate = new Ajv({ allErrors: false }).compile(PLAY_SIGNATURE_SCHEMA);

/**
 * Direct imports bypass HTTP validation. Copy only the bounded signature
 * contract, then validate it exactly; never round, truncate, or clamp counts
 * into evidence that the replay did not contain.
 * @param {unknown} value
 * @returns {Record<string, any>|undefined}
 */
function sanitizePlaySignature(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = /** @type {Record<string, any>} */ (value);
  const schema = raw.version === 1 ? v1 : raw.version === 2 ? v2 : raw.version === 3 ? v3 : null;
  if (!schema) return undefined;
  try {
    const clean = copyContract(raw, schema);
    return validate(clean) && validPlaySignatureSemantics(clean) ? clean : undefined;
  } catch {
    return undefined;
  }
}

/** @param {any} value @param {Record<string, any>} schema @returns {any} */
function copyContract(value, schema) {
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw new Error("Invalid signature array");
    return value.map((item) => copyContract(item, schema.items));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid signature object");
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = copyContract(value[key], childSchema);
    }
    return out;
  }
  return value;
}

/** @param {any[]} rows @param {(row: any) => string|number} key */
const unique = (rows, key) => new Set(rows.map(key)).size === rows.length;
/** @param {number[]} counts */
const total = (counts) => counts.reduce((sum, value) => sum + value, 0);
/** @param {any} slot */
const slotEvents = (slot) => slot.set + slot.add + slot.recall + (slot.clear || 0);

/**
 * JSON shape alone cannot check duplicated slots or self-contradictory totals.
 * Apply this after schema validation in both HTTP and direct-import paths.
 * Legacy v1 totals predate the detailed event contract and remain compatible.
 * @param {Record<string, any>} signature
 * @returns {boolean}
 */
function validPlaySignatureSemantics(signature) {
  const control = signature.controlGroups;
  const actions = signature.actions;
  if (control && (!unique(control.slots, (slot) => slot.slot)
    || !unique(control.transitions || [], (row) => `${row.from}:${row.to}`))) return false;
  if (signature.version === 1) return true;
  if (signature.version === 3 && !validV3Semantics(signature)) return false;
  for (const family of [control, actions].filter(Boolean)) {
    if (family.activeSeconds > signature.windowSec) return false;
    const phases = family.phases || [];
    if (!unique(phases, (row) => row.startSec)) return false;
    for (const phase of phases) {
      const boundary = phase.startSec === 0 ? 120 : phase.startSec === 120 ? 300 : 600;
      if (phase.endSec <= phase.startSec || phase.endSec > Math.min(boundary, family.activeSeconds)) return false;
    }
  }
  if (control) {
    if (total(control.slots.map(slotEvents)) !== control.events) return false;
    for (const slot of control.slots) {
      if (slot.doubleTap > slot.recall || (slot.stealSet || 0) > slot.set
        || (slot.stealAdd || 0) > slot.add || (slot.firstUseSec || 0) > control.activeSeconds
        || (slot.recallIntervals && total(slot.recallIntervals) > Math.max(0, slot.recall - 1))) return false;
    }
    for (const phase of control.phases || []) {
      if (!unique(phase.slots, (slot) => slot.slot) || total(phase.slots.map(slotEvents)) !== phase.events) return false;
    }
    if (!unique(control.commandFollowup || [], (row) => row.slot)) return false;
    for (const followup of control.commandFollowup || []) {
      if (followup.queued > followup.commands || followup.rapidRepeat > followup.commands
        || !unique(followup.abilities || [], (row) => row.name)) return false;
    }
  }
  if (actions && (actions.repeatCommands > actions.commands || actions.queuedCommands > actions.commands
    || actions.events < actions.commands + actions.selectionChanges + actions.cameraMoves
    || !unique(actions.abilityUsage || [], (row) => row.name))) return false;
  return true;
}

module.exports = { PLAY_SIGNATURE_SCHEMA, sanitizePlaySignature, validPlaySignatureSemantics };
