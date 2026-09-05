// @ts-nocheck
"use strict";

const { sanitizePlaySignature } = require("../src/validation/playSignature");
const { validateGameRecord } = require("../src/validation/gameRecord");

// Deliberately small protocol-boundary examples, never player evidence.
function signature() {
  const slot = { slot: 4, set: 1, add: 1, recall: 3, doubleTap: 1,
    stealSet: 1, stealAdd: 0, clear: 0, firstUseSec: 4,
    recallIntervals: [1, 0, 0, 1, 0, 0] };
  const phaseSlot = { slot: 4, set: 1, add: 1, recall: 3,
    stealSet: 1, stealAdd: 0, clear: 0 };
  return {
    version: 2, windowSec: 600,
    controlGroups: {
      events: 5, activeSeconds: 170, slots: [slot],
      transitions: [{ from: 4, to: 4, count: 2 }],
      recallIntervals: [1, 0, 0, 1, 0, 0],
      phases: [{ startSec: 0, endSec: 120, events: 5, slots: [phaseSlot] }],
      commandFollowup: [{ slot: 4, commands: 2, queued: 1, rapidRepeat: 1,
        abilities: [{ name: "TrainMarine", count: 2 }] }],
    },
    actions: {
      activeSeconds: 170, events: 11, commands: 3, selectionChanges: 1,
      cameraMoves: 2, queuedCommands: 1, repeatCommands: 1,
      targetCommands: { none: 3, point: 0, unit: 0, data: 0 },
      actionIntervals: [1, 2, 2, 1, 2, 2], cameraIntervals: [0, 0, 0, 0, 0, 1],
      phases: [{ startSec: 0, endSec: 120, commands: 3,
        selectionChanges: 1, cameraMoves: 2, controlGroups: 5 }],
      abilityUsage: [{ name: "TrainMarine", count: 2 }],
    },
    build: { milestones: [{ name: "Barracks", atSec: 50 }] },
  };
}
function record(playSignature) {
  return { gameId: "boundary-test", date: "2026-09-05T00:00:00.000Z",
    result: "Victory", myRace: "Protoss", map: "Ultralove",
    opponent: { playSignature } };
}

test("version 2 survives both HTTP validation and private storage without loss", () => {
  const raw = signature();
  expect(validateGameRecord(record(raw)).valid).toBe(true);
  expect(sanitizePlaySignature(raw)).toEqual(raw);
  expect(sanitizePlaySignature(raw)).not.toBe(raw);
});

test("version 1 and optional version 2 evidence families remain supported", () => {
  for (const version of [1, 2]) {
    const value = { version, windowSec: 600, build: signature().build };
    expect(validateGameRecord(record(value)).valid).toBe(true);
    expect(sanitizePlaySignature(value)).toEqual(value);
  }
  const value = { version: 2, windowSec: 600, actions: signature().actions };
  expect(validateGameRecord(record(value)).valid).toBe(true);
  expect(sanitizePlaySignature(value)).toEqual(value);
});

test.each([-1, 0.5, 100000, NaN, Infinity, "5", null])(
  "invalid counts never become plausible evidence through clamping: %s", (value) => {
    const raw = signature();
    raw.actions.commands = value;
    expect(validateGameRecord(record(raw)).valid).toBe(false);
    expect(sanitizePlaySignature(raw)).toBeUndefined();
  },
);

test.each([
  (raw) => { raw.controlGroups.slots[0].slot = 10; },
  (raw) => { raw.controlGroups.slots[0].firstUseSec = 601; },
  (raw) => { raw.controlGroups.slots[0].stealSet = -1; },
  (raw) => { raw.actions.actionIntervals.push(0); },
  (raw) => { raw.actions.actionIntervals.pop(); },
  (raw) => { raw.actions.phases[0].startSec = 119; },
  (raw) => { raw.actions.abilityUsage[0].name = "X".repeat(65); },
  (raw) => { raw.controlGroups.phases = Array(4).fill(raw.controlGroups.phases[0]); },
  (raw) => { raw.controlGroups.commandFollowup = Array(11).fill(raw.controlGroups.commandFollowup[0]); },
  (raw) => { raw.controlGroups.commandFollowup[0].abilities = Array(7).fill({ name: "Attack", count: 1 }); },
  (raw) => { raw.controlGroups.slots.push({ ...raw.controlGroups.slots[0], set: 2 }); },
  (raw) => { raw.controlGroups.slots[0].stealSet = 2; },
  (raw) => { raw.controlGroups.events += 1; },
  (raw) => { raw.controlGroups.phases[0].endSec = 121; },
  (raw) => { raw.controlGroups.phases[0].events += 1; },
  (raw) => { raw.actions.repeatCommands = 4; },
])("bounds every nested evidence family: %#", (mutate) => {
  const raw = signature();
  mutate(raw);
  expect(validateGameRecord(record(raw)).valid).toBe(false);
  expect(sanitizePlaySignature(raw)).toBeUndefined();
});

test("direct import drops unknown properties without mutating known evidence", () => {
  const raw = signature();
  raw.actions.unbounded = "X".repeat(100000);
  raw.controlGroups.slots[0].physicalKey = "unknown";
  expect(validateGameRecord(record(raw)).valid).toBe(false);
  expect(sanitizePlaySignature(raw)).toEqual(signature());
  expect(raw.actions.unbounded).toHaveLength(100000);
});
