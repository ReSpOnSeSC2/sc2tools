"use strict";

/** @param {number} maximum @param {number} [minimum] */
const integer = (maximum, minimum = 0) => ({ type: "integer", minimum, maximum });
/** @param {Record<string, any>} properties @param {string[]} required */
const object = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
/** @param {Record<string, any>} items @param {number} maxItems @param {number} [minItems] */
const array = (items, maxItems, minItems = 0) => ({ type: "array", items, maxItems, minItems });
const count = integer(99999);
const time = { type: "number", minimum: 0, maximum: 600 };
const histogram = array(count, 6, 6);
const unit = object({ name: { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" }, count: integer(99999, 1) }, ["name", "count"]);
const assignment = object({ atSec: time, action: { enum: ["set", "add", "stealSet", "stealAdd"] }, units: array(unit, 8, 1) }, ["atSec", "action", "units"]);
const groupMembershipFields = {
  membershipCoverage: object({ assignments: count, decodedAssignments: count, selectionErrors: count }, ["assignments", "decodedAssignments", "selectionErrors"]),
  unitAssignments: array(object({ slot: integer(9), assignments: integer(99999, 1), unitTypes: array(unit, 8, 1), firstAssignment: assignment }, ["slot", "assignments", "unitTypes", "firstAssignment"]), 10),
  openingSequence: array(object({ slot: integer(9), atSec: { ...time, maximum: 60 }, action: { enum: ["set", "add", "stealSet", "stealAdd", "recall"] }, units: array(unit, 8, 1) }, ["slot", "atSec", "action", "units"]), 24),
  sharedAssignments: array(object({ slots: array(integer(9), 2, 2), firstAtSec: time, unitTypes: array(unit, 6, 1) }, ["slots", "firstAtSec", "unitTypes"]), 45),
};
const cameraSchema = object({
  activeSeconds: integer(600, 1), events: count, saves: count, positionUpdates: count, returns: count,
  slots: array(object({ slot: integer(7), saves: integer(9999, 1), firstSaveSec: time,
    returns: integer(9999), firstReturnSec: time, returnIntervals: histogram }, ["slot", "saves", "firstSaveSec", "returns"]), 8),
  phases: array(object({ startSec: { enum: [0, 120, 300] }, endSec: integer(600, 1), saves: count, returns: count }, ["startSec", "endSec", "saves", "returns"]), 3),
  saveOrder: array(integer(7), 8), returnIntervals: histogram,
  transitions: array(object({ from: integer(7), to: integer(7), count: integer(9999, 1) }, ["from", "to", "count"]), 12),
}, ["activeSeconds", "events", "saves", "positionUpdates", "returns", "slots", "phases", "saveOrder"]);

/** @param {any[]} values @param {(value:any)=>any} key */
const unique = (values, key) => new Set(values.map(key)).size === values.length;
/** @param {any[]} values @returns {boolean} */
const validTypes = (values) => unique(values, (row) => row.name);
/** @param {Record<string, any>} signature @returns {boolean} */
function validV3Semantics(signature) {
  const control = signature.controlGroups;
  if (control) {
    const coverage = control.membershipCoverage;
    const assignments = control.unitAssignments || [];
    if (!unique(assignments, (row) => row.slot)) return false;
    if ((assignments.length || control.openingSequence?.length || control.sharedAssignments?.length) && !coverage) return false;
    if (coverage && (coverage.decodedAssignments > coverage.assignments
      || coverage.assignments > control.slots.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.set + row.add, 0)
      || assignments.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.assignments, 0) > coverage.decodedAssignments)) return false;
    for (const row of assignments) {
      if (!validTypes(row.unitTypes) || !validTypes(row.firstAssignment.units)
        || !control.slots.some((/** @type {any} */ slot) => slot.slot === row.slot && row.assignments <= slot.set + slot.add)
        || row.firstAssignment.atSec > control.activeSeconds
        || row.unitTypes.some((/** @type {any} */ type) => type.count > row.assignments)) return false;
    }
    let lastAt = -1;
    for (const row of control.openingSequence || []) {
      if (!validTypes(row.units) || row.atSec < lastAt || row.atSec > control.activeSeconds) return false;
      lastAt = row.atSec;
    }
    const shared = control.sharedAssignments || [];
    if (!unique(shared, (row) => row.slots.join(":"))) return false;
    for (const row of shared) {
      if (row.slots[0] >= row.slots[1] || row.firstAtSec > control.activeSeconds || !validTypes(row.unitTypes)) return false;
    }
  }
  const camera = signature.camera;
  if (!camera) return true;
  if (camera.activeSeconds > signature.windowSec || camera.events < camera.saves + camera.positionUpdates
    || camera.returns > camera.positionUpdates || !unique(camera.slots, (row) => row.slot)
    || camera.slots.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.saves, 0) !== camera.saves
    || camera.slots.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.returns, 0) !== camera.returns
    || !unique(camera.saveOrder, (slot) => slot) || camera.saveOrder.length !== camera.slots.length
    || camera.saveOrder.some((/** @type {number} */ slot) => !camera.slots.some((/** @type {any} */ row) => row.slot === slot))) return false;
  for (const row of camera.slots) {
    if (row.firstSaveSec > camera.activeSeconds || (row.firstReturnSec !== undefined
      && (row.firstReturnSec < row.firstSaveSec || row.firstReturnSec > camera.activeSeconds || !row.returns))
      || (row.returnIntervals || []).reduce((/** @type {number} */ sum, /** @type {number} */ value) => sum + value, 0) > Math.max(0, row.returns - 1)) return false;
  }
  if (!unique(camera.phases, (row) => row.startSec)
    || !unique(camera.transitions || [], (row) => `${row.from}:${row.to}`)
    || camera.phases.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.saves, 0) !== camera.saves
    || camera.phases.reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.returns, 0) !== camera.returns
    || (camera.returnIntervals || []).reduce((/** @type {number} */ sum, /** @type {number} */ value) => sum + value, 0) > Math.max(0, camera.returns - 1)
    || (camera.transitions || []).reduce((/** @type {number} */ sum, /** @type {any} */ row) => sum + row.count, 0) > Math.max(0, camera.returns - 1)
    || (camera.transitions || []).some((/** @type {any} */ row) => row.from === row.to
      || !camera.slots.some((/** @type {any} */ slot) => slot.slot === row.from)
      || !camera.slots.some((/** @type {any} */ slot) => slot.slot === row.to))) return false;
  for (const phase of camera.phases) {
    const boundary = phase.startSec === 0 ? 120 : phase.startSec === 120 ? 300 : 600;
    if (phase.endSec <= phase.startSec || phase.endSec > Math.min(boundary, camera.activeSeconds)) return false;
  }
  return true;
}

module.exports = { groupMembershipFields, cameraSchema, validV3Semantics };
