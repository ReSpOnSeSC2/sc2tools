import { describe, expect, test } from "vitest";
import type { BuildRule } from "./build-rules";
import {
  RULE_QUANTIFIERS,
  RULE_TONE_STRIPE,
  ruleCountValue,
  ruleQuantifier,
  ruleTone,
  withCount,
  withQuantifier,
  type RuleQuantifier,
} from "./build-rules-quantity";

const T = 260;
const before: BuildRule = { type: "before", name: "BuildStargate", time_lt: T };
const notBefore: BuildRule = { type: "not_before", name: "BuildStargate", time_lt: T };
const countMin = (count: number): BuildRule =>
  ({ type: "count_min", name: "BuildStargate", count, time_lt: T });
const countExact = (count: number): BuildRule =>
  ({ type: "count_exact", name: "BuildStargate", count, time_lt: T });
const countMax = (count: number): BuildRule =>
  ({ type: "count_max", name: "BuildStargate", count, time_lt: T });

/** Mirror of buildRulesEvaluator.evaluateRule's type switch (JS and Python v3). */
function passes(rule: BuildRule, occurrences: number): boolean {
  switch (rule.type) {
    case "before":
      return occurrences >= 1;
    case "not_before":
      return occurrences === 0;
    case "count_max":
      return occurrences <= rule.count;
    case "count_exact":
      return occurrences === rule.count;
    case "count_min":
      return occurrences >= rule.count;
  }
}

describe("quantity model", () => {
  test("maps all five stored types (before → at_least, count 1)", () => {
    expect([before, countMin(3), countExact(2), countMax(1), notBefore].map(
      (r) => [ruleQuantifier(r), ruleCountValue(r)],
    )).toEqual([
      ["at_least", 1],
      ["at_least", 3],
      ["exactly", 2],
      ["at_most", 1],
      ["none", null],
    ]);
    expect(RULE_QUANTIFIERS.map((q) => q.id)).toEqual([
      "at_least", "exactly", "at_most", "none",
    ]);
    expect(RULE_QUANTIFIERS.map((q) => q.label)).toEqual([
      "At least", "Exactly", "At most", "None",
    ]);
    expect(RULE_QUANTIFIERS.map((q) => q.addType)).toEqual([
      "before", "count_exact", "count_max", "not_before",
    ]);
  });

  test("before and count_min 1 both read as At least 1", () => {
    for (const rule of [before, countMin(1)]) {
      expect(ruleQuantifier(rule)).toBe("at_least");
      expect(ruleCountValue(rule)).toBe(1);
    }
    for (let n = 0; n <= 5; n += 1) {
      expect(passes(before, n)).toBe(passes(countMin(1), n));
    }
  });

  test("withQuantifier keeps name, time_lt and proxy and drops stray keys", () => {
    const stray = { ...countMin(3), proxy: true, tol: 2, extra: "x" } as unknown as BuildRule;
    expect(withQuantifier(stray, "exactly")).toEqual({
      type: "count_exact", name: "BuildStargate", count: 3, time_lt: T, proxy: true,
    });
    expect(withQuantifier(stray, "none")).toEqual({
      type: "not_before", name: "BuildStargate", time_lt: T, proxy: true,
    });
    const noProxy = { ...before, proxy: false } as BuildRule;
    expect(withQuantifier(noProxy, "at_most")).toEqual(countMax(1));
  });

  test("withQuantifier returns the same object for an unchanged quantifier", () => {
    const rules = [before, countMin(4), countExact(0), countMax(2), notBefore];
    for (const rule of rules) {
      expect(withQuantifier(rule, ruleQuantifier(rule), 7)).toBe(rule);
    }
  });

  test("withQuantifier carries the number (count_min 3 → at_most = count_max 3; count_max 0 → at_least = before; not_before → exactly uses carry or 1)", () => {
    expect(withQuantifier(countMin(3), "at_most")).toEqual(countMax(3));
    expect(withQuantifier(countMax(0), "at_least")).toEqual(before);
    expect(withQuantifier(countExact(4), "at_least")).toEqual(countMin(4));
    expect(withQuantifier(before, "exactly")).toEqual(countExact(1));
    expect(withQuantifier(notBefore, "exactly", 3)).toEqual(countExact(3));
    expect(withQuantifier(notBefore, "exactly")).toEqual(countExact(1));
    expect(withQuantifier(notBefore, "at_least", 2)).toEqual(countMin(2));
    expect(withQuantifier(notBefore, "at_least", 0)).toEqual(before);
    expect(withQuantifier(notBefore, "at_most", 999)).toEqual(countMax(200));
  });

  test("withCount converts before only at 2+, keeps count_min ≥ 1, allows 0 for exactly/at_most, clamps 200", () => {
    expect(withCount(before, 1)).toBe(before);
    expect(withCount(before, 0)).toBe(before);
    expect(withCount({ ...before, proxy: true }, "2")).toEqual({
      type: "count_min", name: "BuildStargate", count: 2, time_lt: T, proxy: true,
    });
    expect(withCount(countMin(3), 1)).toEqual(countMin(1));
    expect(withCount(countMin(3), 0)).toEqual(countMin(1));
    expect(withCount(countExact(2), 0)).toEqual(countExact(0));
    expect(withCount(countMax(2), 0)).toEqual(countMax(0));
    expect(withCount(countMax(2), 500)).toEqual(countMax(200));
    expect(withCount(notBefore, 5)).toBe(notBefore);
    const same = countExact(2);
    expect(withCount(same, 2)).toBe(same);
    const floor = countMin(1);
    expect(withCount(floor, 0)).toBe(floor);
  });

  test("ruleTone treats exactly 0 / at_most 0 as forbid", () => {
    expect(ruleTone(before)).toBe("require");
    expect(ruleTone(countMin(4))).toBe("require");
    expect(ruleTone(countExact(1))).toBe("require");
    expect(ruleTone(countMax(1))).toBe("cap");
    expect(ruleTone(notBefore)).toBe("forbid");
    expect(ruleTone(countExact(0))).toBe("forbid");
    expect(ruleTone(countMax(0))).toBe("forbid");
    expect(ruleTone({ ...countMin(2), name: "  " })).toBe("blank");
    expect(RULE_TONE_STRIPE).toEqual({
      require: "border-l-success/60",
      cap: "border-l-border-strong",
      forbid: "border-l-danger/60",
      blank: "border-l-border",
    });
  });

  test("semantics table", () => {
    const expected: Record<RuleQuantifier, (n: number, c: number) => boolean> = {
      at_least: (n, c) => n >= c,
      exactly: (n, c) => n === c,
      at_most: (n, c) => n <= c,
      none: (n) => n === 0,
    };
    for (const { id } of RULE_QUANTIFIERS) {
      for (let c = 1; c <= 4; c += 1) {
        const rule = withCount(withQuantifier(before, id, c), c);
        expect(ruleQuantifier(rule)).toBe(id);
        for (let n = 0; n <= 5; n += 1) {
          expect([id, c, n, passes(rule, n)]).toEqual([id, c, n, expected[id](n, c)]);
        }
      }
    }
  });
});
