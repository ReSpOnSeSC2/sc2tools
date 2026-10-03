import { describe, expect, test } from "vitest";
import type { BuildRule } from "./build-rules";
import {
  applyRepeatRowRaise,
  raiseRuleForRepeatRow,
} from "./build-rules-repeat";

// A 2-Stargate opener's source timeline: two Stargates, one Void Ray.
const rows = [
  { what: "BuildStargate", t: 170, isProxy: false },
  { what: "BuildStargate", t: 230, isProxy: false },
  { what: "BuildVoidRay", t: 290, isProxy: false },
];
const firstStargate: BuildRule = {
  type: "before",
  name: "BuildStargate",
  time_lt: 200,
};

describe("raiseRuleForRepeatRow", () => {
  test("the 2nd Stargate adds '≥ 2 by then' and keeps 'first by 3:20'", () => {
    const rules: BuildRule[] = [
      { type: "before", name: "BuildGateway", time_lt: 90 },
      firstStargate,
    ];
    const raise = raiseRuleForRepeatRow(rules, rows, rows[1]);
    expect(raise).toEqual({
      index: 1,
      insert: true,
      rule: { type: "count_min", name: "BuildStargate", count: 2, time_lt: 260 },
    });
    expect(applyRepeatRowRaise(rules, raise!)).toEqual([
      { type: "before", name: "BuildGateway", time_lt: 90 },
      firstStargate,
      { type: "count_min", name: "BuildStargate", count: 2, time_lt: 260 },
    ]);
  });

  test("the row a rule already covers adds nothing", () => {
    expect(raiseRuleForRepeatRow([firstStargate], rows, rows[0])).toBeNull();
    const counted: BuildRule[] = [
      firstStargate,
      { type: "count_min", name: "BuildStargate", count: 2, time_lt: 260 },
    ];
    expect(raiseRuleForRepeatRow(counted, rows, rows[1])).toBeNull();
  });

  test("a single Void Ray never asks for more than one", () => {
    const rule: BuildRule = { type: "before", name: "BuildVoidRay", time_lt: 320 };
    expect(raiseRuleForRepeatRow([rule], rows, rows[2])).toBeNull();
  });

  test("an existing count grows in place, keeping a later deadline", () => {
    const voidRays = [290, 330, 370, 410].map((t) => ({
      what: "BuildVoidRay",
      t,
      isProxy: false,
    }));
    const rules: BuildRule[] = [
      { type: "before", name: "BuildVoidRay", time_lt: 320 },
      { type: "count_min", name: "BuildVoidRay", count: 2, time_lt: 600 },
    ];
    const raise = raiseRuleForRepeatRow(rules, voidRays, voidRays[3]);
    expect(raise).toEqual({
      index: 1,
      insert: false,
      rule: { type: "count_min", name: "BuildVoidRay", count: 4, time_lt: 600 },
    });
    expect(applyRepeatRowRaise(rules, raise!)).toEqual([
      rules[0],
      { type: "count_min", name: "BuildVoidRay", count: 4, time_lt: 600 },
    ]);
  });

  test("a cap below the row's count is never turned into '≥ N'", () => {
    for (const type of ["count_max", "count_exact"] as const) {
      const rules: BuildRule[] = [
        firstStargate,
        { type, name: "BuildStargate", count: 1, time_lt: 360 },
      ];
      expect(raiseRuleForRepeatRow(rules, rows, rows[1])).toBeNull();
    }
  });

  test("not_before alone offers nothing", () => {
    const rule: BuildRule = { type: "not_before", name: "BuildStargate", time_lt: 200 };
    expect(raiseRuleForRepeatRow([rule], rows, rows[1])).toBeNull();
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
    expect(raiseRuleForRepeatRow([rule], gates, gates[1])).toBeNull();
    expect(raiseRuleForRepeatRow([rule], gates, gates[2])).toEqual({
      index: 0,
      insert: true,
      rule: {
        type: "count_min",
        name: "BuildGateway",
        count: 2,
        time_lt: 105,
        proxy: true,
      },
    });
  });

  test("rows at the 30:00 ceiling share one clamped time and are not counted", () => {
    const late = [
      { what: "BuildStargate", t: 1200, isProxy: false },
      { what: "BuildStargate", t: 1800, isProxy: false },
      { what: "BuildStargate", t: 1800, isProxy: false },
    ];
    const rule: BuildRule = { type: "before", name: "BuildStargate", time_lt: 1230 };
    expect(raiseRuleForRepeatRow([rule], late, late[1])).toBeNull();
  });
});
