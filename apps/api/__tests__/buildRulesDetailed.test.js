// @ts-nocheck
"use strict";
const { evaluateRule, evaluateRules, evaluateRulesDetailed } = require("../src/services/buildRulesEvaluator");
const event = (time, name = "Barracks", extra = {}) => ({ time, name, is_building: true, category: "building", ...extra });
const rule = (type, count = 2, extra = {}) => ({ type, count, name: "BuildBarracks", time_lt: 120, ...extra });

test.each([
  ["before", 1, [90, 30], true, 30, "event"],
  ["before", 1, [], false, 120, "deadline"],
  ["not_before", 0, [], true, 120, "deadline"],
  ["not_before", 0, [90, 30], false, 30, "event"],
  ["count_min", 2, [110, 30, 90], true, 90, "event"],
  ["count_min", 2, [30], false, 120, "deadline"],
  ["count_max", 2, [30, 90], true, 120, "deadline"],
  ["count_max", 2, [110, 30, 90], false, 110, "event"],
  ["count_exact", 2, [30, 90], true, 120, "deadline"],
  ["count_exact", 2, [30], false, 120, "deadline"],
  ["count_exact", 2, [110, 30, 90], false, 110, "event"],
])("%s preserves the count verdict and distinguishes event from deadline evidence", (type, count, times, pass, evidenceSec, evidenceKind) => {
  const definition = rule(type, count), events = times.map(time => event(time));
  const detailed = evaluateRulesDetailed([definition], events);
  expect(detailed.rules[0]).toMatchObject({ index: 0, pass, unavailable: false, got: times.length, need: count, evidenceSec, evidenceKind });
  expect(detailed.rules[0].pass).toBe(evaluateRule(definition, events).pass);
  expect(detailed.passedCount).toBe(evaluateRules([definition], events).passedCount);
  expect(detailed.matchPct).toBe(pass ? 100 : 0);
});

test("counts duplicate recorded events, excludes deadline equality, and never mutates inputs", () => {
  const events = Object.freeze([event(120), event(90), event(30), event(30)].map(Object.freeze));
  const definitions = Object.freeze([Object.freeze(rule("count_exact", 3))]);
  expect(evaluateRulesDetailed(definitions, events).rules[0]).toMatchObject({ got: 3, pass: true, evidenceSec: 120, evidenceKind: "deadline" });
  expect(events.map(row => row.time)).toEqual([120, 90, 30, 30]);
});

test("every rule verdict remains identical to evaluateRule across count/window combinations", () => {
  const events = [event(120), event(45), event(89), event(89), event(30, "Factory")];
  for (const type of ["before", "not_before", "count_min", "count_max", "count_exact"]) {
    for (const count of [0, 1, 2, 3, 4]) {
      const definitions = [rule(type, count), rule("before", 1, { name: "BuildFactory" })];
      const result = evaluateRulesDetailed(definitions, events), legacy = evaluateRules(definitions, events);
      expect(result.rules.map(row => row.pass)).toEqual(definitions.map(value => evaluateRule(value, events).pass));
      expect(result.passedCount).toBe(legacy.passedCount);
      expect(result.ruleCount).toBe(legacy.ruleCount);
    }
  }
});

test("uses the canonical prerequisite and explicit hallucination filters for counts and evidence", () => {
  const definition = rule("count_min", 1, { name: "TrainPhoenix", time_lt: 300 });
  const events = [event(50, "Phoenix", { name: "TrainPhoenix", is_building: false }), event(100, "Stargate"),
    event(150, "TrainPhoenix", { is_building: false, hallucinated: true }), event(200, "TrainPhoenix", { is_building: false })];
  expect(evaluateRulesDetailed([definition], events).rules[0]).toMatchObject({ pass: true, got: 1, evidenceSec: 200 });
  expect(evaluateRule(definition, events).pass).toBe(true);
});

test("proxy unknown remains unknown in text, counts and the overall percentage", () => {
  const result = evaluateRulesDetailed([rule("before", 1), rule("count_max", 0, { proxy: true })], [event(45)]);
  expect(result).toMatchObject({ passedCount: 1, knownCount: 1, ruleCount: 2, matchPct: null });
  expect(result.rules[1]).toMatchObject({ pass: false, unavailable: true, got: null, evidenceSec: null, evidenceKind: null });
  expect(result.rules[1].sentence).toContain("evidence unavailable");
});

test("known proxy evidence uses only annotated matching structures", () => {
  const events = [event(20, "Barracks", { is_proxy: false, proxy_classification_known: true }),
    event(70, "Barracks", { is_proxy: true, proxy_classification_known: true })];
  expect(evaluateRulesDetailed([rule("before", 1, { proxy: true })], events).rules[0]).toMatchObject({ pass: true, got: 1, evidenceSec: 70 });
});

test("missing extraction is different from a valid empty log and zero rules have no grade", () => {
  const definitions = [rule("not_before", 0)];
  expect(evaluateRulesDetailed(definitions, null)).toMatchObject({ matchPct: null, knownCount: 0 });
  expect(evaluateRulesDetailed(definitions, []).rules[0]).toMatchObject({ pass: true, got: 0 });
  expect(evaluateRulesDetailed(definitions, [], false).rules[0].unavailable).toBe(true);
  expect(evaluateRulesDetailed([], [])).toMatchObject({ ruleCount: 0, matchPct: null });
});

test("invalid saved rules do not invent failed evidence or a full-match grade", () => {
  const result = evaluateRulesDetailed([rule("not_a_rule"), rule("before", 1, { name: "bad name" })], []);
  expect(result.matchPct).toBeNull();
  expect(result.rules.every(row => row.unavailable && row.got === null && row.evidenceSec === null)).toBe(true);
});
