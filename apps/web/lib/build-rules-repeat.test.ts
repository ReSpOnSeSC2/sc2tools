import { describe, expect, test } from "vitest";
import type { BuildRule } from "./build-rules";
import {
  raiseRuleForRepeatRow,
  repeatRowCountRule,
} from "./build-rules-repeat";

// A 2-Stargate opener's source timeline: two Stargates, one Void Ray.
const rows = [
  { what: "BuildStargate", t: 170, isProxy: false },
  { what: "BuildStargate", t: 230, isProxy: false },
  { what: "BuildVoidRay", t: 290, isProxy: false },
];

describe("repeatRowCountRule", () => {
  test("the 2nd Stargate row raises 'before' to at least 2 by that row", () => {
    const rule: BuildRule = { type: "before", name: "BuildStargate", time_lt: 200 };
    expect(repeatRowCountRule(rule, rows, rows[1])).toEqual({
      type: "count_min",
      name: "BuildStargate",
      count: 2,
      time_lt: 260,
    });
  });

  test("the row a 'before' rule already covers adds nothing", () => {
    const rule: BuildRule = { type: "before", name: "BuildStargate", time_lt: 200 };
    expect(repeatRowCountRule(rule, rows, rows[0])).toBeNull();
  });

  test("a single Void Ray never asks for more than one", () => {
    const rule: BuildRule = { type: "before", name: "BuildVoidRay", time_lt: 320 };
    expect(repeatRowCountRule(rule, rows, rows[2])).toBeNull();
  });

  test("a count_min only grows, and keeps a later deadline the user set", () => {
    const voidRays = [290, 330, 370, 410].map((t) => ({
      what: "BuildVoidRay",
      t,
      isProxy: false,
    }));
    const rule: BuildRule = {
      type: "count_min",
      name: "BuildVoidRay",
      count: 2,
      time_lt: 600,
    };
    expect(repeatRowCountRule(rule, voidRays, voidRays[3])).toEqual({
      type: "count_min",
      name: "BuildVoidRay",
      count: 4,
      time_lt: 600,
    });
    expect(repeatRowCountRule(rule, voidRays, voidRays[1])).toBeNull();
  });

  test("not_before, count_max and count_exact stay as the user set them", () => {
    for (const type of ["not_before", "count_max", "count_exact"] as const) {
      const rule = (type === "not_before"
        ? { type, name: "BuildStargate", time_lt: 200 }
        : { type, name: "BuildStargate", count: 1, time_lt: 200 }) as BuildRule;
      expect(repeatRowCountRule(rule, rows, rows[1])).toBeNull();
    }
  });

  test("a proxy-only rule counts proxied rows and ignores the rest", () => {
    const gates = [
      { what: "BuildGateway", t: 40, isProxy: true },
      { what: "BuildGateway", t: 60, isProxy: false },
      { what: "BuildGateway", t: 75, isProxy: true },
    ];
    const rule: BuildRule = {
      type: "before",
      name: "BuildGateway",
      time_lt: 70,
      proxy: true,
    };
    expect(repeatRowCountRule(rule, gates, gates[1])).toBeNull();
    expect(repeatRowCountRule(rule, gates, gates[2])).toEqual({
      type: "count_min",
      name: "BuildGateway",
      count: 2,
      time_lt: 105,
      proxy: true,
    });
  });
});

describe("raiseRuleForRepeatRow", () => {
  test("finds the token's rule among the others", () => {
    const rules: BuildRule[] = [
      { type: "before", name: "BuildGateway", time_lt: 90 },
      { type: "before", name: "BuildStargate", time_lt: 200 },
    ];
    expect(raiseRuleForRepeatRow(rules, rows, rows[1])).toEqual({
      index: 1,
      rule: {
        type: "count_min",
        name: "BuildStargate",
        count: 2,
        time_lt: 260,
      },
    });
    expect(raiseRuleForRepeatRow(rules, rows, rows[2])).toBeNull();
  });

  test("leaves the build alone when another rule already asks for that many", () => {
    const rules: BuildRule[] = [
      { type: "before", name: "BuildStargate", time_lt: 200 },
      { type: "count_min", name: "BuildStargate", count: 2, time_lt: 270 },
    ];
    expect(raiseRuleForRepeatRow(rules, rows, rows[1])).toBeNull();
  });
});
