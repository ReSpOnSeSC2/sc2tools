// @ts-nocheck
"use strict";

const Ajv = require("ajv");
const {
  PLAY_SIGNATURE_SCHEMA,
  sanitizePlaySignature,
  validPlaySignatureSemantics,
} = require("../src/validation/playSignature");
const { controlGroupComponent, actionComponent } = require("../src/services/opponentBehavior");

const validate = new Ajv({ allErrors: true }).compile(PLAY_SIGNATURE_SCHEMA);

// Constructed protocol summaries are confined to regression tests. Production
// signatures and separate corpus audits are extracted from actual replays.
function signature() {
  return {
    version: 3,
    windowSec: 600,
    controlGroups: {
      activeSeconds: 600,
      events: 100,
      slots: [0, 9].map((slot) => ({ slot, set: 10, add: 0, recall: 40, doubleTap: 8,
        stealSet: 0, stealAdd: 0, clear: 0, firstUseSec: slot ? 1 : 0 })),
      membershipCoverage: { assignments: 20, decodedAssignments: 20, selectionErrors: 0 },
      unitAssignments: [0, 9].map((slot) => ({ slot, assignments: 10,
        unitTypes: [{ name: "Nexus", count: 10 }],
        firstAssignment: { action: "set", atSec: slot ? 1 : 0, units: [{ name: "Nexus", count: 1 }] } })),
      sharedAssignments: [{ slots: [0, 9], firstAtSec: 1, unitTypes: [{ name: "Nexus", count: 1 }] }],
      openingSequence: [
        { slot: 0, action: "set", atSec: 0, units: [{ name: "Nexus", count: 1 }] },
        { slot: 9, action: "set", atSec: 1, units: [{ name: "Nexus", count: 1 }] },
        { slot: 0, action: "recall", atSec: 1.4, units: [{ name: "Nexus", count: 1 }] },
      ],
    },
    actions: { activeSeconds: 600, events: 1000, commands: 600, selectionChanges: 100,
      cameraMoves: 200, queuedCommands: 150, repeatCommands: 70 },
    camera: {
      activeSeconds: 600, events: 22, saves: 4, positionUpdates: 18, returns: 9,
      slots: [
        { slot: 0, saves: 2, firstSaveSec: 0, returns: 4, firstReturnSec: 4, returnIntervals: [0, 2, 1, 0, 0, 0] },
        { slot: 7, saves: 2, firstSaveSec: 2, returns: 5, firstReturnSec: 5, returnIntervals: [0, 2, 2, 0, 0, 0] },
      ],
      saveOrder: [0, 7],
      phases: [
        { startSec: 0, endSec: 120, saves: 2, returns: 1 },
        { startSec: 120, endSec: 300, saves: 2, returns: 5 },
        { startSec: 300, endSec: 600, saves: 0, returns: 3 },
      ],
      returnIntervals: [0, 4, 4, 0, 0, 0],
      transitions: [{ from: 0, to: 7, count: 3 }, { from: 7, to: 0, count: 2 }],
    },
  };
}

function game(id, value = signature()) {
  return { gameId: id, date: new Date("2026-09-01T12:00:00Z"), opponent: { race: "Protoss", playSignature: value } };
}

function dimension(component, key) {
  const result = component.dimensions.find((row) => row.key === key);
  expect(result).toBeDefined();
  return result;
}

function assertValid(value) {
  expect(validate(value)).toBe(true);
  expect(validPlaySignatureSemantics(value)).toBe(true);
  expect(sanitizePlaySignature(value)).toEqual(value);
}

describe("v3 replay evidence validation", () => {
  test("preserves boundary group slots 0/9, camera slots 0/7, exact pairs, zero times and recall examples", () => {
    const value = signature();
    assertValid(value);
    const clean = sanitizePlaySignature(value);
    expect(clean.controlGroups.slots.map((slot) => slot.slot)).toEqual([0, 9]);
    expect(clean.camera.slots.map((slot) => slot.slot)).toEqual([0, 7]);
    expect(clean.controlGroups.unitAssignments[0].firstAssignment.atSec).toBe(0);
    expect(clean.camera.slots[0].firstSaveSec).toBe(0);
    expect(clean.controlGroups.openingSequence[2]).toMatchObject({ action: "recall", atSec: 1.4 });
  });

  test("accepts camera updates without a target while requiring counted positions and saves to fit inside all events", () => {
    const value = signature();
    // Zoom/rotation-only records increase event count without positionUpdates.
    value.camera.events += 3;
    assertValid(value);
    value.camera.events = value.camera.saves + value.camera.positionUpdates - 1;
    expect(sanitizePlaySignature(value)).toBeUndefined();
  });

  test("preserves a fully decoded observation with no saved bookmarks", () => {
    const value = signature();
    value.camera = { activeSeconds: 600, events: 10, saves: 0, positionUpdates: 8,
      returns: 0, slots: [], saveOrder: [],
      phases: [0, 120, 300].map((startSec, index) => ({ startSec, endSec: [120, 300, 600][index], saves: 0, returns: 0 })) };
    assertValid(value);
  });

  test("keeps camera-only signatures usable without inventing commands or selection counts", () => {
    const value = { version: 3, windowSec: 600, camera: signature().camera };
    assertValid(value);
    const result = actionComponent([game("a", value)], [game("b", value)]);
    expect(dimension(result, "camera_saved_slots").score).toBe(1);
    expect(dimension(result, "command_rate")).toMatchObject({ score: null, targetSamples: 0, candidateSamples: 0 });
    expect(result.cameraHabits.returnAttribution).toBe("position_only");
  });
});

describe("v3 corrupt evidence rejection", () => {
  test.each([
    ["out-of-range control slot", (value) => { value.controlGroups.slots[1].slot = 10; }],
    ["out-of-range camera slot", (value) => { value.camera.slots[1].slot = 8; }],
    ["duplicate membership slots", (value) => { value.controlGroups.unitAssignments[1].slot = 0; }],
    ["reversed shared pair", (value) => { value.controlGroups.sharedAssignments[0].slots = [9, 0]; }],
    ["same slot used twice in a pair", (value) => { value.controlGroups.sharedAssignments[0].slots = [0, 0]; }],
    ["duplicate shared pairs", (value) => { value.controlGroups.sharedAssignments.push(structuredClone(value.controlGroups.sharedAssignments[0])); }],
    ["more decoded assignments than observed", (value) => { value.controlGroups.membershipCoverage.decodedAssignments = 21; }],
    ["membership coverage exceeding all group assignments", (value) => { value.controlGroups.membershipCoverage.assignments = 21; }],
    ["a membership slot with no group assignments", (value) => { value.controlGroups.unitAssignments[0].slot = 5; }],
    ["assignment totals exceeding decoded coverage", (value) => { value.controlGroups.unitAssignments[0].assignments = 11; }],
    ["unit frequency exceeding assignments", (value) => { value.controlGroups.unitAssignments[0].unitTypes[0].count = 11; }],
    ["membership evidence without coverage", (value) => { delete value.controlGroups.membershipCoverage; }],
    ["duplicate unit names", (value) => { value.controlGroups.unitAssignments[0].unitTypes.push({ name: "Nexus", count: 1 }); }],
    ["opening actions in reverse time order", (value) => { value.controlGroups.openingSequence[1].atSec = 2; }],
    ["opening beyond its observation window", (value) => { value.controlGroups.openingSequence[2].atSec = 61; }],
    ["camera save counts that do not sum", (value) => { value.camera.saves += 1; value.camera.events += 1; }],
    ["camera return counts that do not sum", (value) => { value.camera.returns += 1; }],
    ["duplicate camera slots", (value) => { value.camera.slots[1].slot = 0; }],
    ["duplicate saved-slot order", (value) => { value.camera.saveOrder = [0, 0]; }],
    ["camera return before save", (value) => { value.camera.slots[1].firstReturnSec = 1; }],
    ["camera return after observed window", (value) => { value.camera.slots[1].firstReturnSec = 601; }],
    ["invalid phase endpoint", (value) => { value.camera.phases[0].endSec = 121; }],
    ["camera phase saves that do not sum", (value) => { value.camera.phases[0].saves += 1; }],
    ["camera phase returns that do not sum", (value) => { value.camera.phases[0].returns += 1; }],
    ["more global return intervals than possible gaps", (value) => { value.camera.returnIntervals = [9, 0, 0, 0, 0, 0]; }],
    ["more per-slot intervals than possible gaps", (value) => { value.camera.slots[0].returnIntervals = [4, 0, 0, 0, 0, 0]; }],
    ["a transition from a never-saved bookmark", (value) => { value.camera.transitions[0].from = 3; }],
    ["more camera switching transitions than returns allow", (value) => { value.camera.transitions[0].count = 9; }],
    ["a transition to a never-saved bookmark", (value) => { value.camera.transitions[0].to = 3; }],
    ["a bookmark switching transition to itself", (value) => { value.camera.transitions[0].to = 0; }],
    ["duplicate camera transitions", (value) => { value.camera.transitions.push(structuredClone(value.camera.transitions[0])); }],
  ])("rejects %s without silently clipping invalid evidence", (_name, mutate) => {
    const value = signature();
    mutate(value);
    expect(sanitizePlaySignature(value)).toBeUndefined();
  });
});

describe("v3 identity comparisons", () => {
  test("distinguishes the same Nexus in two groups from separate Nexuses assigned to the same two numbers", () => {
    const target = game("target");
    const same = game("same");
    const separate = game("separate");
    delete separate.opponent.playSignature.controlGroups.sharedAssignments;
    assertValid(separate.opponent.playSignature);
    const close = controlGroupComponent([target], [same]);
    const different = controlGroupComponent([target], [separate]);
    expect(dimension(close, "shared_unit_groups").score).toBe(1);
    expect(dimension(different, "shared_unit_groups")).toMatchObject({ score: 0, targetSamples: 1, candidateSamples: 1 });
    expect(dimension(different, "assigned_unit_groups").score).toBe(1);
    expect(close.score).toBeGreaterThan(different.score);
    expect(different.membershipHabits.find((habit) => habit.slots.length === 2)).toMatchObject({
      unitType: "Nexus", slots: [0, 9], targetGames: 1, candidateGames: 0,
    });
  });

  test("uses complete decoding with omitted sharedAssignments as observed absence", () => {
    const a = game("a"); const b = game("b");
    delete a.opponent.playSignature.controlGroups.sharedAssignments;
    delete b.opponent.playSignature.controlGroups.sharedAssignments;
    const result = controlGroupComponent([a], [b]);
    expect(dimension(result, "shared_unit_groups")).toMatchObject({ score: 1, targetSamples: 1, candidateSamples: 1 });
  });

  test.each([1, 2])("legacy v%i membership stays unavailable instead of becoming zero overlap", (version) => {
    const legacy = game("legacy");
    legacy.opponent.playSignature.version = version;
    const result = controlGroupComponent([game("target")], [legacy]);
    expect(dimension(result, "assigned_unit_groups")).toMatchObject({ score: null, targetSamples: 1, candidateSamples: 0 });
    expect(dimension(result, "shared_unit_groups").score).toBeNull();
    expect(dimension(result, "opening_group_sequence").score).toBeNull();
    expect(result.membershipSamples).toEqual({ target: 1, candidate: 0 });
  });
});

describe("v3 membership coverage and opening sequences", () => {
  test("insufficient membership decoding cannot contribute a strong membership or opening match", () => {
    const partial = game("partial");
    const controls = partial.opponent.playSignature.controlGroups;
    controls.membershipCoverage.assignments = 100;
    controls.membershipCoverage.decodedAssignments = 20;
    const result = controlGroupComponent([game("target")], [partial]);
    for (const key of ["assigned_unit_groups", "shared_unit_groups", "opening_group_sequence"]) {
      expect(dimension(result, key)).toMatchObject({ score: null, candidateSamples: 0 });
    }
  });

  test("80 percent decoding can compare observed assignments but incomplete no-overlap cannot prove a mismatch", () => {
    const partial = game("partial");
    const controls = partial.opponent.playSignature.controlGroups;
    controls.membershipCoverage.assignments = 25;
    controls.membershipCoverage.decodedAssignments = 20;
    delete controls.sharedAssignments;
    const result = controlGroupComponent([game("target")], [partial]);
    expect(dimension(result, "assigned_unit_groups").score).toBe(1);
    expect(dimension(result, "shared_unit_groups")).toMatchObject({ score: null, candidateSamples: 0 });
  });

  test("opening sequence distinguishes changed group order and delayed recalls despite identical slot totals", () => {
    const changed = game("changed");
    const steps = changed.opponent.playSignature.controlGroups.openingSequence;
    steps[0].slot = 9; steps[1].slot = 0; steps[2].atSec = 25;
    const result = controlGroupComponent([game("target")], [changed]);
    expect(dimension(result, "assigned_unit_groups").score).toBe(1);
    expect(dimension(result, "opening_group_sequence").score).toBeLessThan(0.6);
    expect(result.openingExamples.candidate).toEqual(steps);
    expect(result.openingExamples.target[0].atSec).toBe(0);
  });
});

describe("v3 evidence explanations and camera comparisons", () => {
  test("reports per-game habits with median times and does not attach a pair time to later unit types", () => {
    const a = game("a"); const b = game("b");
    b.opponent.playSignature.controlGroups.unitAssignments[0].firstAssignment.atSec = 4;
    a.opponent.playSignature.controlGroups.sharedAssignments[0].unitTypes.push({ name: "Probe", count: 1 });
    const result = controlGroupComponent([a, b], [game("candidate")]);
    expect(result.membershipHabits.find((habit) => habit.slots.length === 1 && habit.slots[0] === 0))
      .toMatchObject({ unitType: "Nexus", targetGames: 2, targetFirstSec: 2 });
    const probePair = result.membershipHabits.find((habit) => habit.unitType === "Probe");
    expect(probePair.targetFirstSec).toBeUndefined();
  });

  test("camera comparisons preserve slot identities, setup order, return rhythm, and explicit attribution", () => {
    const target = game("target"); const changed = game("changed");
    changed.opponent.playSignature.camera.saveOrder = [7, 0];
    changed.opponent.playSignature.camera.returnIntervals = [8, 0, 0, 0, 0, 0];
    const result = actionComponent([target], [changed]);
    expect(dimension(result, "camera_saved_slots").score).toBe(1);
    expect(dimension(result, "camera_save_order").score).toBe(0);
    expect(dimension(result, "camera_return_intervals").score).toBe(0);
    expect(result.cameraHabits).toMatchObject({ targetSamples: 1, candidateSamples: 1, returnAttribution: "position_only" });
    expect(result.cameraHabits.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: 0, targetGames: 1, candidateGames: 1, targetFirstSaveSec: 0 }),
      expect.objectContaining({ slot: 7, targetSavesPerGame: 2, targetReturnsPerGame: 5 }),
    ]));
  });

  test("missing camera extraction has no camera score or fabricated zero per-game rates", () => {
    const missing = game("missing");
    delete missing.opponent.playSignature.camera;
    const result = actionComponent([game("target")], [missing]);
    expect(dimension(result, "camera_saved_slots")).toMatchObject({ score: null, targetSamples: 1, candidateSamples: 0 });
    expect(result.cameraHabits.candidateSamples).toBe(0);
    expect(result.cameraHabits.slots[0].candidateSavesPerGame).toBeUndefined();
    expect(result.cameraHabits.slots[0].candidateReturnsPerGame).toBeUndefined();
  });

  test("retains which camera slot has each return rhythm despite equal overall camera cadence", () => {
    const target = game("target"); const changed = game("changed");
    target.opponent.playSignature.camera.slots[0].returnIntervals = [3, 0, 0, 0, 0, 0];
    target.opponent.playSignature.camera.slots[1].returnIntervals = [0, 0, 0, 0, 0, 4];
    changed.opponent.playSignature.camera.slots[0].returnIntervals = [0, 0, 0, 0, 0, 3];
    changed.opponent.playSignature.camera.slots[1].returnIntervals = [4, 0, 0, 0, 0, 0];
    assertValid(target.opponent.playSignature);
    assertValid(changed.opponent.playSignature);
    const result = actionComponent([target], [changed]);
    expect(dimension(result, "camera_return_intervals").score).toBe(1);
    expect(dimension(result, "camera_slot_return_intervals").score).toBe(0);
  });
});
