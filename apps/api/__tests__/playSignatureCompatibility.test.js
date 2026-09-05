// @ts-nocheck
"use strict";

const { controlGroupComponent, actionComponent, hasIncompatibleLegacySteals } = require("../src/services/opponentBehavior");
const { scoreCandidate } = require("../src/services/opponentIdentityMatcher");

// Isolated constructed summaries test migration edge cases. The corresponding
// old/new real-replay extraction comparison is performed in the local audit.
function game(id, version, steals = 0) {
  return { gameId: id, opponent: { playSignature: {
    version, windowSec: 600,
    controlGroups: { activeSeconds: 600, events: 103,
      slots: [{ slot: 0, set: 3, add: 0, recall: 100, doubleTap: 10,
        stealSet: steals, stealAdd: 0, clear: 0, firstUseSec: 0,
        recallIntervals: [10, 20, 30, 20, 15, 4] }],
      recallIntervals: [10, 20, 30, 20, 15, 4] },
    actions: { activeSeconds: 600, events: 2000, commands: 1500,
      cameraMoves: 200, selectionChanges: 100, queuedCommands: 150, repeatCommands: 50,
      actionIntervals: [500, 200, 300, 200, 200, 99],
      cameraIntervals: [10, 20, 30, 20, 100, 19] },
  } } };
}

describe("v2/v3 control-group steal compatibility", () => {
  test.each(["stealSet", "stealAdd"])("omits contaminated v2 %s observations from both behavior families against v3", (field) => {
    const legacy = game("legacy", 2);
    legacy.opponent.playSignature.controlGroups.slots[0][field] = 1;
    const current = game("current", 3, 1);
    for (const [target, candidate] of [[[current], [legacy]], [[legacy], [current]]]) {
      expect(hasIncompatibleLegacySteals(target, candidate)).toBe(true);
      expect(controlGroupComponent(target, candidate)).toBeNull();
      expect(actionComponent(target, candidate)).toBeNull();
    }
  });

  test("keeps legacy-only comparisons usable", () => {
    const a = game("a", 2, 1); const b = game("b", 2, 1);
    expect(hasIncompatibleLegacySteals([a], [b])).toBe(false);
    expect(controlGroupComponent([a], [b]).score).toBe(1);
    expect(actionComponent([a], [b]).score).toBe(1);
  });

  test("retains unaffected v2 observations when comparing with v3", () => {
    const a = game("a", 2); const b = game("b", 3);
    expect(hasIncompatibleLegacySteals([a], [b])).toBe(false);
    expect(controlGroupComponent([a], [b]).score).toBe(1);
    expect(actionComponent([a], [b]).score).toBe(1);
  });

  test("mixed histories report sample counts only for compatible observations", () => {
    const current = game("current", 3, 1);
    const retained = game("retained", 3, 1);
    const staleA = game("stale-a", 2, 1); const staleB = game("stale-b", 2, 1);
    const original = JSON.stringify([current, retained, staleA, staleB]);
    for (const component of [controlGroupComponent, actionComponent]) {
      const result = component([current, staleA], [staleB, retained]);
      expect(result).toMatchObject({ score: 1, targetSamples: 1, candidateSamples: 1 });
      expect(result.dimensions.filter((row) => row.score !== null)
        .every((row) => row.targetSamples === 1 && row.candidateSamples === 1)).toBe(true);
    }
    expect(JSON.stringify([current, retained, staleA, staleB])).toBe(original);
  });

  test("restores evidence after the affected replay is reprocessed", () => {
    const target = game("target", 3, 1); const candidate = game("candidate", 3, 1);
    expect(hasIncompatibleLegacySteals([target], [candidate])).toBe(false);
    expect(controlGroupComponent([target], [candidate]).score).toBe(1);
    expect(actionComponent([target], [candidate]).score).toBe(1);
  });

});

describe("migration fallback evidence", () => {
  test("retains independent build evidence and explains why behavior needs re-sync", () => {
    const target = game("target", 3, 1); const candidate = game("candidate", 2, 1);
    for (const replay of [target, candidate]) {
      replay.myRace = "Terran";
      replay.opponent.playSignature.build = { milestones: [
        { name: "Pylon", atSec: 18 }, { name: "Gateway", atSec: 40 },
        { name: "Assimilator", atSec: 45 }, { name: "CyberneticsCore", atSec: 90 },
      ] };
    }
    const result = scoreCandidate([target], [candidate], "T");
    expect(result).not.toBeNull();
    expect(result.evidence.buildOrders).toMatchObject({ score: 1, detailLevel: "timed_milestones" });
    expect(result.evidence.controlGroups).toBeNull();
    expect(result.evidence.actions).toBeNull();
    expect(result.caveats).toContain("legacy_steal_events_reprocess");
  });

  test("preserves established v1 control comparisons", () => {
    const legacy = game("legacy", 1, 1); const current = game("current", 3, 1);
    expect(hasIncompatibleLegacySteals([legacy], [current])).toBe(false);
    expect(controlGroupComponent([legacy], [current]).score).toBe(1);
    expect(actionComponent([legacy], [current])).toBeNull();
  });
});
