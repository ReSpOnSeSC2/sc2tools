import { describe, expect, test } from "vitest";
import {
  RULES_MAX_PER_BUILD,
  formatTime,
  type BuildRule,
  type SourceTimelineRow,
} from "./build-rules";
import {
  nameCountKey,
  nameCountWarning,
  parseNameCounts,
  rulesRequireNothing,
} from "./build-rules-name-check";

function row(what: string, t: number, isProxy = false): SourceTimelineRow {
  return {
    key: `t${t}:${what}`,
    t,
    what,
    display: what.replace(/^Build/, ""),
    timeDisplay: formatTime(t),
    race: "Protoss",
    category: "building",
    isBuilding: true,
    isProxy,
    isTech: false,
  };
}

// A 2-Stargate opener's source timeline: two Stargates, one Void Ray.
const rows = [
  row("BuildGateway", 60),
  row("BuildStargate", 170),
  row("BuildStargate", 230),
  row("BuildVoidRay", 290),
];
const firstStargate: BuildRule = { type: "before", name: "BuildStargate", time_lt: 200 };
const NAME = "PvZ - 2 Stargate Void Ray";

describe("parseNameCounts", () => {
  test("fires for 2 Stargate, 4 Gate, 3 Rax, 2 Port, 2 SG", () => {
    expect(parseNameCounts(NAME)).toEqual([
      { n: 2, token: "BuildStargate", text: "2 Stargate" },
    ]);
    expect(parseNameCounts("4 Gate")).toEqual([
      { n: 4, token: "BuildGateway", text: "4 Gate" },
    ]);
    expect(parseNameCounts("3 Rax Reaper")).toEqual([
      { n: 3, token: "BuildBarracks", text: "3 Rax" },
    ]);
    expect(parseNameCounts("2 Port Banshee")).toEqual([
      { n: 2, token: "BuildStarport", text: "2 Port" },
    ]);
    expect(parseNameCounts("2 SG Phoenix")).toEqual([
      { n: 2, token: "BuildStargate", text: "2 SG" },
    ]);
    expect(parseNameCounts("TvP 3-Robo / 2 factories")).toEqual([
      { n: 3, token: "BuildRoboticsFacility", text: "3-Robo" },
      { n: 2, token: "BuildFactory", text: "2 factories" },
    ]);
  });

  test("silent for 12 Pool, 1-1-1, 2 Base Colossus, 3 Hatch, 17 Hatch 18 Gas 17 Pool", () => {
    for (const name of [
      "12 Pool",
      "1-1-1",
      "2 Base Colossus",
      "3 Hatch",
      "17 Hatch 18 Gas 17 Pool",
      "14 Gate Expand",
      "2.5 Gate",
      "2 Gatekeeper",
      "Stargate Void Ray",
    ]) {
      expect(parseNameCounts(name)).toEqual([]);
    }
  });
});

describe("nameCountWarning", () => {
  test("silent when a rule already requires N", () => {
    const rules: BuildRule[] = [
      firstStargate,
      { type: "count_min", name: "BuildStargate", count: 2, time_lt: 260 },
    ];
    expect(nameCountWarning(NAME, rules, rows, true)).toBeNull();
    const exact: BuildRule[] = [
      { type: "count_exact", name: "BuildStargate", count: 2, time_lt: 260, proxy: true },
    ];
    expect(nameCountWarning(NAME, exact, rows, false)).toBeNull();
    expect(nameCountWarning("12 Pool", [], rows, true)).toBeNull();
  });

  test("offers raise only in create mode with an Nth row", () => {
    expect(nameCountWarning(NAME, [firstStargate], rows, true)).toEqual({
      kind: "raise",
      text: "The build name says “2 Stargate”, but your rules pass with 1 Stargate.",
      n: 2,
      token: "BuildStargate",
      nthRow: rows[2],
    });
  });

  test("'manual' in edit mode, without an Nth row, when capped or at the rule limit", () => {
    const manual = {
      kind: "manual",
      text: "The build name says “2 Stargate”, but your rules pass with 1 Stargate. Raise the number on that rule and check its time.",
      n: 2,
      token: "BuildStargate",
    };
    expect(nameCountWarning(NAME, [firstStargate], rows, false)).toEqual(manual);
    expect(nameCountWarning(NAME, [firstStargate], rows.slice(0, 2), true)).toEqual(manual);
    const capped: BuildRule[] = [
      firstStargate,
      { type: "count_max", name: "BuildStargate", count: 1, time_lt: 400 },
    ];
    expect(nameCountWarning(NAME, capped, rows, true)).toEqual(manual);
    const full: BuildRule[] = [
      firstStargate,
      ...Array.from({ length: RULES_MAX_PER_BUILD - 1 }, (_, i): BuildRule => ({
        type: "before", name: `BuildZealot${i}`, time_lt: 300,
      })),
    ];
    expect(nameCountWarning(NAME, full, rows, true)?.kind).toBe("manual");
  });

  test("reads 'pass with no X' when the token is only capped or forbidden", () => {
    const rules: BuildRule[] = [{ type: "not_before", name: "BuildStargate", time_lt: 120 }];
    expect(nameCountWarning(NAME, rules, rows, true)).toEqual({
      kind: "manual",
      text: "The build name says “2 Stargate”, but your rules pass with no Stargate. Change that rule to “At least 2”, or add an “At least 2” rule.",
      n: 2,
      token: "BuildStargate",
    });
    // Raising an At most cap still passes with none, so the advice is the same.
    const capped: BuildRule[] = [
      { type: "count_max", name: "BuildStargate", count: 1, time_lt: 360 },
    ];
    expect(nameCountWarning(NAME, capped, rows, false)?.text).toBe(
      "The build name says “2 Stargate”, but your rules pass with no Stargate. Change that rule to “At least 2”, or add an “At least 2” rule.",
    );
    const three = [row("BuildGateway", 20), row("BuildGateway", 40), ...rows];
    const gates: BuildRule[] = [
      { type: "count_min", name: "BuildGateway", count: 2, time_lt: 300 },
    ];
    expect(nameCountWarning("4 Gate", gates, three, false)?.text).toBe(
      "The build name says “4 Gate”, but your rules pass with 2 Gateways. Raise the number on that rule and check its time.",
    );
  });

  test("skips upgrade notation and the opponent's build", () => {
    for (const name of ["PvT 2/2 Robo", "ZvP vs 4 Gate", "TvP vs. 2 Stargate", "Anti 2-Rax", "PvZ versus 3 Rax"]) {
      expect(parseNameCounts(name)).toEqual([]);
    }
    expect(parseNameCounts("vs Zerg 2 Stargate").map((c) => c.n)).toEqual([2]);
  });

  test("'missing' when no rule exists", () => {
    expect(nameCountWarning("3 Rax Reaper", [firstStargate], rows, true)).toEqual({
      kind: "missing",
      text: "The build name says “3 Rax”, but no rule checks Barracks.",
      n: 3,
      token: "BuildBarracks",
    });
    expect(nameCountWarning("2 Robo Immortal", [], rows, true)?.text).toBe(
      "The build name says “2 Robo”, but no rule checks Robotics Facilities.",
    );
  });

  test("shows only the first mismatch and skips dismissed counts", () => {
    const name = "2 Stargate into 3 Gate";
    const rules: BuildRule[] = [firstStargate];
    expect(nameCountWarning(name, rules, rows, true)?.token).toBe("BuildStargate");
    const dismissed = new Set([nameCountKey({ token: "BuildStargate", n: 2 })]);
    expect(nameCountWarning(name, rules, rows, true, dismissed)).toMatchObject({
      kind: "missing",
      token: "BuildGateway",
      n: 3,
    });
  });
});

describe("rulesRequireNothing", () => {
  const atMost: BuildRule = { type: "count_max", name: "BuildStargate", count: 1, time_lt: 300 };
  const none: BuildRule = { type: "not_before", name: "BuildRoboticsFacility", time_lt: 240 };
  const exactZero: BuildRule = { type: "count_exact", name: "BuildForge", count: 0, time_lt: 240 };
  const blank: BuildRule = { type: "before", name: "", time_lt: 60 };

  test("true for all-None / At most / Exactly 0 rule sets", () => {
    expect(rulesRequireNothing([none])).toBe(true);
    expect(rulesRequireNothing([atMost])).toBe(true);
    expect(rulesRequireNothing([exactZero])).toBe(true);
    expect(rulesRequireNothing([none, atMost, exactZero])).toBe(true);
  });

  test("false once an At least rule exists, ignores blank names", () => {
    expect(rulesRequireNothing([none, firstStargate])).toBe(false);
    expect(rulesRequireNothing([
      atMost,
      { type: "count_exact", name: "BuildStargate", count: 1, time_lt: 300 },
    ])).toBe(false);
    expect(rulesRequireNothing([none, blank])).toBe(true);
    expect(rulesRequireNothing([blank])).toBe(false);
    expect(rulesRequireNothing([])).toBe(false);
  });
});
