// @ts-nocheck
"use strict";

const { controlGroupComponent, actionComponent } = require("../src/services/opponentBehavior");
const { scoreCandidate, assessCandidates, attachOpenSetLikelihoods } = require("../src/services/opponentIdentityMatcher");

// Constructed protocol summaries exercise isolated edge cases. Application
// features use only replay-extracted data; real corpus evaluation is separate.
function replay(id, options = {}) {
  const { slot = 1, firstUse = 4, events = 500, version = 2, duration = 600 } = options;
  const operations = { slot, set: 15, add: 5, recall: 480, stealSet: 10, stealAdd: 3, clear: 2 };
  const intervals = [20, 60, 200, 100, 70, 29];
  return { gameId: id, myRace: "Terran", opponent: {
    race: "Protoss", strategy: "Gateway Expand", opening: "Gateway Expand",
    playSignature: { version, windowSec: 600, controlGroups: {
      events, activeSeconds: duration,
      slots: [{ ...operations, doubleTap: 90, firstUseSec: firstUse, recallIntervals: intervals }],
      transitions: [{ from: slot, to: (slot + 1) % 10, count: 50 }],
      recallIntervals: intervals,
      phases: [{ startSec: 0, endSec: Math.min(120, duration), events: 100, slots: [{ ...operations, recall: 80 }] },
        ...(duration > 120 ? [{ startSec: 120, endSec: Math.min(300, duration), events: 400, slots: [operations] }] : [])],
      commandFollowup: [{ slot, commands: 200, queued: 10, rapidRepeat: 30, abilities: [{ name: "TrainProbe", count: 150 }] }],
    }, actions: { activeSeconds: duration, events: 2500, commands: 1500,
      selectionChanges: 300, cameraMoves: 200, queuedCommands: 200, repeatCommands: 400,
      targetCommands: { none: 1000, point: 350, unit: 140, data: 10 },
      actionIntervals: [500, 200, 100, 100, 50, 50], cameraIntervals: [10, 20, 60, 70, 20, 19],
      phases: [{ startSec: 0, endSec: Math.min(120, duration), commands: 500, selectionChanges: 100, cameraMoves: 30, controlGroups: 100 }],
      abilityUsage: [{ name: "TrainProbe", count: 1200 }, { name: "Move", count: 300 }],
    }, build: { milestones: Array.from({ length: 10 }, (_, i) => ({ name: `Tech${i}`, atSec: i * 30 + 30 })) } },
  } };
}
function dimension(component, key) { return component.dimensions.find((row) => row.key === key); }

describe("detailed replay behavior", () => {
  test("distinguishes when groups are first used despite identical totals", () => {
    const a = replay("a"); const b = replay("b", { firstUse: 95 });
    const result = controlGroupComponent([a], [b]);
    expect(dimension(result, "recall_slots").score).toBe(1);
    expect(dimension(result, "first_use_1")).toMatchObject({ targetValue: 4, candidateValue: 95, unit: "seconds" });
    expect(dimension(result, "first_use_1").score).toBeLessThan(0.1);
    expect(result.score).toBeLessThan(1);
  });

  test("distinguishes group usage by game phase", () => {
    const a = replay("a"); const b = replay("b");
    b.opponent.playSignature.controlGroups.phases[0].slots[0].slot = 8;
    const result = controlGroupComponent([a], [b]);
    expect(dimension(result, "phase_0").score).toBe(0);
    expect(dimension(result, "recall_slots").score).toBe(1);
  });

  test("short games do not invent an unseen full phase", () => {
    const result = controlGroupComponent([replay("short", { duration: 50 })], [replay("long")]);
    expect(dimension(result, "phase_0").score).toBeNull();
    expect(dimension(result, "phase_120").score).toBeNull();
    expect(dimension(result, "phase_0")).toMatchObject({ targetSamples: 0, candidateSamples: 1 });
  });

  test("fully observed inactivity is compared to actual phase activity", () => {
    const a = replay("a"); const b = replay("b");
    b.opponent.playSignature.controlGroups.phases[0].slots = [];
    b.opponent.playSignature.controlGroups.phases[0].events = 0;
    expect(dimension(controlGroupComponent([a], [b]), "phase_0").score).toBe(0);
  });

  test("compares command meaning after recall, not just which slots occur", () => {
    const a = replay("a"); const b = replay("b");
    b.opponent.playSignature.controlGroups.commandFollowup[0].abilities[0].name = "Attack";
    const result = controlGroupComponent([a], [b]);
    expect(dimension(result, "group_abilities").score).toBe(0);
    expect(dimension(result, "group_commands").score).toBe(1);
    expect(result.highlights).toContain("Group 1 commands after recall: target TrainProbe; candidate Attack");
  });

  test("weights normalized replay observations equally despite a spam-heavy game", () => {
    const a = replay("a"); const b = replay("b"); const spam = replay("spam", { slot: 8 });
    spam.opponent.playSignature.controlGroups.slots[0].recall *= 100;
    const result = controlGroupComponent([a], [b, spam]);
    expect(dimension(result, "recall_slots").score).toBe(0.5);
    expect(result.consistency.candidate).toBe(0);
  });

  test("legacy and incomplete rich signatures do not invent advanced matches", () => {
    const a = replay("a"); const b = replay("b", { version: 1 });
    expect(actionComponent([a], [b])).toBeNull();
    const result = controlGroupComponent([a], [b]);
    expect(result.advancedSamples).toEqual({ target: 1, candidate: 0 });
    expect(dimension(result, "group_abilities").score).toBeNull();
    expect(dimension(result, "transitions").score).toBeNull();
    expect(dimension(result, "double_tap").score).toBeNull();
    const legacy = replay("legacy");
    legacy.opponent.playSignature.controlGroups = { events: 500, activeSeconds: 600,
      slots: [{ slot: 1, set: 15, add: 5, recall: 480, doubleTap: 90 }] };
    const partial = controlGroupComponent([a], [legacy]);
    expect(dimension(partial, "group_updates").score).toBeNull();
    expect(partial.advancedSamples.candidate).toBe(0);
  });

  test("empty or unsupported signatures remain unavailable", () => {
    const a = replay("a"); const b = replay("b", { version: 3 });
    expect(controlGroupComponent([a], [b])).toBeNull();
    b.opponent.playSignature.version = 2;
    b.opponent.playSignature.controlGroups.slots = [{ slot: 99, recall: 999 }];
    expect(controlGroupComponent([a], [b])).toBeNull();
    b.opponent.playSignature.actions = { activeSeconds: 600, events: 30, commands: 0, selectionChanges: 0, cameraMoves: 0 };
    expect(actionComponent([a], [b])).toBeNull();
  });

  test("action rhythm includes queued and repeat shares without claiming keys", () => {
    const result = actionComponent([replay("a")], [replay("b")]);
    expect(result.score).toBe(1);
    expect(dimension(result, "queued_commands")).toMatchObject({ unit: "ratio", targetValue: 0.1333, candidateValue: 0.1333 });
    expect(dimension(result, "command_rate")).toMatchObject({ unit: "per_minute", targetValue: 150 });
    expect(JSON.stringify(result)).not.toMatch(/key binding|keystroke/i);
  });

  test("identical detail from one replay still has low evidence strength", () => {
    const result = scoreCandidate([replay("a")], [replay("b")], "T");
    expect(result.patternMatch).toBe(1);
    expect(result.confidence).toBe("low");
    expect(result.evidenceQuality).toBeLessThan(0.2);
  });

  test("repeated well-observed independent replays can establish strong evidence", () => {
    const result = scoreCandidate(Array.from({ length: 5 }, (_, i) => replay(`a${i}`)),
      Array.from({ length: 8 }, (_, i) => replay(`b${i}`)), "T");
    expect(result.confidence).toBe("high");
    expect(result.evidenceQuality).toBeGreaterThan(0.8);
  });

  test("duplicate replay ids cannot inflate sample strength or compare to themselves", () => {
    const a = replay("a"); const b = replay("b");
    const result = scoreCandidate(Array(8).fill(a), [a, ...Array(8).fill(b)], "T");
    expect(result.sample).toMatchObject({ targetGames: 1, candidateGames: 1 });
    expect(result.confidence).toBe("low");
  });

  test("many very sparse control traces do not become high quality", () => {
    const target = Array.from({ length: 5 }, (_, i) => replay(`a${i}`, { events: 1, duration: 10 }));
    const candidate = Array.from({ length: 8 }, (_, i) => replay(`b${i}`, { events: 1, duration: 10 }));
    for (const row of [...target, ...candidate]) {
      delete row.opponent.playSignature.actions;
      delete row.opponent.playSignature.build;
      delete row.opponent.strategy; delete row.opponent.opening;
    }
    const result = scoreCandidate(target, candidate, "T");
    expect(result.confidence).toBe("low");
    expect(result.caveats).toContain("sparse_control_group_events");
  });

  test("a single rich replay beside many legacy rows cannot supply high confidence", () => {
    const target = Array.from({ length: 5 }, (_, i) => replay(`a${i}`, { version: i ? 1 : 2 }));
    const candidate = Array.from({ length: 8 }, (_, i) => replay(`b${i}`, { version: i ? 1 : 2 }));
    const result = scoreCandidate(target, candidate, "T");
    expect(result.confidence).not.toBe("high");
    expect(result.evidence.actions.targetSamples).toBe(1);
  });

  test("actions-only leads do not claim nonexistent build or control evidence", () => {
    const a = replay("a"); const b = replay("b");
    for (const row of [a, b]) {
      delete row.opponent.playSignature.build; delete row.opponent.playSignature.controlGroups;
      delete row.opponent.strategy; delete row.opponent.opening;
    }
    const result = scoreCandidate([a], [b], "T");
    expect(result.evidence.actions).not.toBeNull();
    expect(result.caveats).not.toContain("build_only_reprocess_for_control_groups");
    expect(result.caveats).not.toContain("control_groups_only_no_build_match");
  });

  test("shared classifier labels are capped even with many games", () => {
    const a = Array.from({ length: 8 }, (_, i) => replay(`a${i}`));
    const b = Array.from({ length: 8 }, (_, i) => replay(`b${i}`));
    for (const row of [...a, ...b]) delete row.opponent.playSignature;
    const result = scoreCandidate(a, b, "T");
    expect(result.patternMatch).toBe(0.55);
    expect(result.confidence).toBe("low");
    expect(result.caveats).toContain("labels_only_build_evidence");
  });

  test("more samples cannot push a poorer fit above a closer well-observed replay", () => {
    const query = [replay("query")];
    const close = scoreCandidate(query, [replay("close")], "T");
    const familiar = scoreCandidate(query, Array.from({ length: 12 }, (_, i) => replay(`other${i}`, { slot: 7 })), "T");
    expect(close.rankScore).toBeGreaterThan(familiar.rankScore);
    expect(close.confidence).toBe("low");
  });

  test("depth alone does not turn a dissimilar player into a lead", () => {
    const candidate = { rankScore: 0.44, patternMatch: 0.44, evidenceQuality: 0.95, confidence: "medium", caveats: [] };
    expect(assessCandidates([candidate], false).status).toBe("insufficient");
  });

  test("close competing candidates downgrade high evidence and explain ambiguity", () => {
    const candidates = [0.86, 0.85].map((rankScore) => ({ rankScore, patternMatch: 0.9, evidenceQuality: 0.9, confidence: "high", caveats: [] }));
    expect(assessCandidates(candidates, false).status).toBe("ambiguous");
    expect(candidates.every((c) => c.confidence === "medium" && c.caveats.includes("ambiguous_candidates"))).toBe(true);
  });

  test("large pools preserve unknown mass and exact aggregation before display rounding", () => {
    const target = { buildGames: 1, controlGroupGames: 1, actionGames: 1 };
    const candidates = Array.from({ length: 499 }, () => ({ rankScore: 0.54, evidenceQuality: 0.1 }));
    const { unknownLikelihood } = attachOpenSetLikelihoods(candidates, target);
    expect(unknownLikelihood).toBeGreaterThan(0.7);
    const known = candidates.reduce((sum, c) => sum + c.likelihood, 0);
    expect(known + unknownLikelihood).toBeCloseTo(1, 4);
    const one = [{ rankScore: 0.54, evidenceQuality: 0.1 }];
    expect(attachOpenSetLikelihoods(one, target).unknownLikelihood).toBe(unknownLikelihood);
  });
});
