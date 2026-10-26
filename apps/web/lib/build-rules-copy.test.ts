import { describe, expect, test } from "vitest";
import type { BuildRule, RuleType } from "./build-rules";
import { humanizeRuleEntity as broadcastEntity } from "./build-rule-entity";
import {
  RULES_LEGEND,
  RULES_LEGEND_FOOTER,
  describeRule,
  describeRuleFailure,
  duplicateRuleToast,
  groupRulesForSummary,
  humanizeRuleEntity,
  pluralizeEntity,
  ruleContexts,
  ruleEntity,
  ruleReadout,
  ruleReadoutText,
  ruleSummaryGroup,
  ruleSummaryParts,
  ruleSummaryText,
} from "./build-rules-copy";

const GLYPHS = /[≥≤=✓✗⚙★▶]/;

test("broadcast display names retain the editor export and legacy punctuation", () => {
  expect(broadcastEntity).toBe(humanizeRuleEntity);
  for (const [stored, label] of [
    ["ResearchAdeptPiercingAttack", "Resonating Glaives"],
    ["Buildsomethingnew", "Somethingnew"],
    ["  O'Brien'sLegacyThing2  ", "O'Brien's Legacy Thing 2"],
    ["ResearchProtossGroundWeaponsLevel1", "Protoss Ground Weapons Level 1"],
  ]) {
    expect(broadcastEntity(stored)).toBe(label);
    expect(humanizeRuleEntity(stored)).toBe(label);
  }
});

function rule(
  type: RuleType,
  name: string,
  time_lt: number,
  count = 1,
  proxy = false,
): BuildRule {
  const extra = proxy ? { proxy: true as const } : {};
  if (type === "before" || type === "not_before") return { type, name, time_lt, ...extra };
  return { type, name, count, time_lt, ...extra };
}

describe("entity names", () => {
  test("humanizes tokens (Glaives, LurkerMP, SwarmHostMP, VikingFighter, Research levels)", () => {
    expect(humanizeRuleEntity("ResearchAdeptPiercingAttack")).toBe("Resonating Glaives");
    expect(humanizeRuleEntity("ResearchResonatingGlaives")).toBe("Resonating Glaives");
    expect(humanizeRuleEntity("MorphLurkerMP")).toBe("Lurker");
    expect(humanizeRuleEntity("BuildSwarmHostMP")).toBe("Swarm Host");
    expect(humanizeRuleEntity("BuildVikingFighter")).toBe("Viking");
    expect(humanizeRuleEntity("ResearchProtossGroundWeaponsLevel1")).toBe(
      "Protoss Ground Weapons Level 1",
    );
    expect(humanizeRuleEntity("BuildRoboticsFacility")).toBe("Robotics Facility");
    expect(humanizeRuleEntity("BuildSCV")).toBe("SCV");
    expect(humanizeRuleEntity("  ")).toBe("");
  });

  test("pluralizes (Stargate, Void Ray, Phoenix, Nexus, Roach, Factory, Robotics Facility, Gateway, Barracks, High Templar, Templar Archive, Colossus, Sentry)", () => {
    const cases: Array<[string, string]> = [
      ["Stargate", "Stargates"],
      ["Void Ray", "Void Rays"],
      ["Phoenix", "Phoenixes"],
      ["Nexus", "Nexuses"],
      ["Roach", "Roaches"],
      ["Factory", "Factories"],
      ["Robotics Facility", "Robotics Facilities"],
      ["Gateway", "Gateways"],
      ["Barracks", "Barracks"],
      ["High Templar", "High Templar"],
      ["Templar Archive", "Templar Archives"],
      ["Templar Archives", "Templar Archives"],
      ["Colossus", "Colossi"],
      ["Sentry", "Sentries"],
      ["Planetary Fortress", "Planetary Fortresses"],
    ];
    for (const [one, many] of cases) expect(pluralizeEntity(one)).toBe(many);
  });

  test("ruleEntity: singular only for 1, proxied prefix, uncountable research, blank fallback", () => {
    const voidRay = rule("before", "BuildVoidRay", 400);
    expect(ruleEntity(voidRay, 1)).toBe("Void Ray");
    expect(ruleEntity(voidRay, 0)).toBe("Void Rays");
    expect(ruleEntity(rule("before", "BuildBarracks", 120, 1, true), 1)).toBe("proxied Barracks");
    expect(ruleEntity(rule("before", "ResearchBlink", 330), 3)).toBe("Blink research");
    expect(ruleEntity(rule("before", "", 60), 1)).toBe("unit, building or upgrade");
    expect(ruleEntity(rule("before", "", 60), 2)).toBe("units, buildings or upgrades");
    expect(ruleEntity(rule("before", "", 60, 1, true), 2)).toBe("proxied buildings");
  });
});

describe("describeRule", () => {
  test("describeRule for 5 types × n ∈ {0,1,2} × proxy", () => {
    const out: Record<string, string> = {};
    for (const type of ["before", "count_min", "count_exact", "count_max", "not_before"] as const) {
      for (const n of [0, 1, 2]) {
        for (const proxy of [false, true]) {
          out[`${type} ${n}${proxy ? " proxy" : ""}`] = describeRule(
            rule(type, "BuildBarracks", 120, n, proxy),
          );
        }
      }
    }
    expect(out["before 0"]).toBe("at least 1 Barracks before 2:00");
    expect(out["before 1 proxy"]).toBe("at least 1 proxied Barracks before 2:00");
    expect(out["count_min 2"]).toBe("at least 2 Barracks before 2:00");
    expect(out["count_min 2 proxy"]).toBe("at least 2 proxied Barracks before 2:00");
    expect(out["count_exact 0"]).toBe("no Barracks before 2:00");
    expect(out["count_exact 1 proxy"]).toBe("exactly 1 proxied Barracks before 2:00");
    expect(out["count_exact 2"]).toBe("exactly 2 Barracks before 2:00");
    expect(out["count_max 0 proxy"]).toBe("no proxied Barracks before 2:00");
    expect(out["count_max 1"]).toBe("at most 1 Barracks before 2:00");
    expect(out["count_max 2"]).toBe("at most 2 Barracks before 2:00");
    expect(out["not_before 2"]).toBe("no Barracks before 2:00");
    expect(out["not_before 0 proxy"]).toBe("no proxied Barracks before 2:00");
    for (const text of Object.values(out)) expect(text).not.toMatch(GLYPHS);

    expect(describeRule(rule("before", "BuildVoidRay", 400))).toBe("at least 1 Void Ray before 6:40");
    expect(describeRule(rule("count_min", "BuildVoidRay", 600, 4))).toBe("at least 4 Void Rays before 10:00");
    expect(describeRule(rule("count_exact", "BuildStargate", 300, 2))).toBe("exactly 2 Stargates before 5:00");
    expect(describeRule(rule("count_max", "BuildStargate", 360, 1))).toBe("at most 1 Stargate before 6:00");
    expect(describeRule(rule("not_before", "BuildRoboticsFacility", 240))).toBe(
      "no Robotics Facility before 4:00",
    );
  });

  test("ports the old formatRule cases (Glaives label, MorphBaneling, a bare token)", () => {
    const glaives = rule("before", "ResearchAdeptPiercingAttack", 330);
    expect(describeRule(glaives)).toBe("at least 1 Resonating Glaives research before 5:30");
    expect(glaives.name).toBe("ResearchAdeptPiercingAttack");
    expect(describeRule(rule("before", "MorphBaneling", 180))).toBe("at least 1 Baneling before 3:00");
    expect(describeRule(rule("before", "ResearchBlink", 425))).toBe("at least 1 Blink research before 7:05");
    expect(describeRule(rule("before", "Stargate", 210))).toBe("at least 1 Stargate before 3:30");
    expect(describeRule(rule("count_max", "TrainPhoenix", 300, 2))).toBe("at most 2 Phoenixes before 5:00");
  });
});

describe("ruleReadout", () => {
  test("splits the sentence into lead, strong, rest, time and note", () => {
    expect(ruleReadout(rule("before", "BuildVoidRay", 400))).toEqual({
      lead: "Passes with ",
      strong: "1 or more",
      rest: " Void Rays started before ",
      time: "6:40",
      note: " — one is enough.",
    });
    expect(ruleReadout(rule("count_max", "BuildStargate", 360, 1))).toMatchObject({
      strong: "0 or 1",
      note: " — games with none pass too.",
      noteTone: "warning",
    });
  });

  test("readout says one is enough / sets the first one's deadline / in total / games with none pass too / same as None / research / blank / invalid / proxy on non-building", () => {
    const text = (r: BuildRule) => ruleReadoutText(r);
    expect(text(rule("before", "BuildVoidRay", 400))).toBe(
      "Passes with 1 or more Void Rays started before 6:40 — one is enough.",
    );
    expect(text(rule("count_min", "BuildVoidRay", 400, 1))).toBe(
      "Passes with 1 or more Void Rays started before 6:40 — one is enough.",
    );
    expect(text(rule("count_min", "BuildVoidRay", 600, 4))).toBe(
      "Passes with 4 or more Void Rays started before 10:00.",
    );
    expect(text(rule("count_exact", "BuildStargate", 300, 2))).toBe(
      "Passes with exactly 2 Stargates started before 5:00 — 1 or 3 fails.",
    );
    expect(text(rule("count_exact", "BuildStargate", 300, 1))).toBe(
      "Passes with exactly 1 Stargate started before 5:00 — none or 2 fails.",
    );
    expect(text(rule("count_max", "BuildStargate", 360, 1))).toBe(
      "Passes with 0 or 1 Stargate started before 6:00 — games with none pass too.",
    );
    expect(text(rule("count_max", "BuildStargate", 360, 3))).toBe(
      "Passes with 0 to 3 Stargates started before 6:00 — games with none pass too.",
    );
    expect(text(rule("not_before", "BuildRoboticsFacility", 240))).toBe(
      "Passes when no Robotics Facility starts before 4:00 — at 4:00 or later, or never, is fine.",
    );
    for (const type of ["count_exact", "count_max"] as const) {
      expect(text(rule(type, "BuildStargate", 300, 0))).toBe(
        "Passes when no Stargate starts before 5:00 — 0 works the same as None.",
      );
    }
    expect(text(rule("before", "BuildBarracks", 120, 1, true))).toBe(
      "Passes with 1 or more proxied Barracks started before 2:00 — one is enough.",
    );

    // Two rules of one token: the first sets a deadline, the count is a total.
    const pair = [
      rule("before", "BuildStargate", 200),
      rule("count_min", "BuildStargate", 260, 2),
    ];
    const ctx = ruleContexts(pair);
    expect(ctx).toEqual([
      { sameTokenElsewhere: true, higherFloorElsewhere: true },
      { sameTokenElsewhere: true, higherFloorElsewhere: false },
    ]);
    expect(ruleReadoutText(pair[0], ctx[0])).toBe(
      "Passes with 1 or more Stargates started before 3:20 — sets the first one's deadline.",
    );
    expect(ruleReadoutText(pair[1], ctx[1])).toBe(
      "Passes with 2 or more Stargates in total started before 4:20.",
    );

    expect(text(rule("before", "ResearchBlink", 330))).toBe(
      "Passes when Blink research starts before 5:30.",
    );
    expect(ruleReadout(rule("before", "ResearchBlink", 330)).strong).toBe("Blink research");
    expect(text(rule("not_before", "ResearchBlink", 330))).toBe(
      "Passes when no Blink research starts before 5:30 — at 5:30 or later, or never, is fine.",
    );
    expect(ruleReadout(rule("count_min", "ResearchBlink", 330, 2))).toMatchObject({
      note: " — research starts once per game, so this rarely passes.",
      noteTone: "warning",
    });
    expect(text(rule("count_exact", "ResearchBlink", 330, 2))).toBe(
      "Passes with exactly 2 Blink research started before 5:30 — research starts once per game, so this rarely passes.",
    );

    expect(ruleReadout(rule("before", "", 60))).toEqual({
      lead: "",
      strong: "",
      rest: "",
      time: "",
      note: "Enter a unit, building or upgrade to finish this rule.",
      noteTone: "dim",
    });
    expect(ruleReadout(rule("before", "Build Void Ray", 60))).toMatchObject({
      note: "This name won't be saved: use one word with no spaces, like BuildVoidRay or ResearchBlink.",
      noteTone: "warning",
    });
    expect(ruleReadout(rule("before", "BuildMarine", 60, 1, true))).toMatchObject({
      note: "Only count proxied works for buildings. Enter one, like BuildPylon, or untick it.",
      noteTone: "danger",
    });
  });

  test("ruleContexts ignores blank names and other tokens", () => {
    expect(ruleContexts([
      rule("before", "", 60),
      rule("count_min", "", 60, 3),
      rule("before", "BuildGateway", 60),
      rule("count_min", "BuildStargate", 60, 3),
    ])).toEqual([
      { sameTokenElsewhere: false, higherFloorElsewhere: false },
      { sameTokenElsewhere: false, higherFloorElsewhere: false },
      { sameTokenElsewhere: false, higherFloorElsewhere: false },
      { sameTokenElsewhere: false, higherFloorElsewhere: false },
    ]);
    const capped = ruleContexts([
      rule("before", "BuildStargate", 200),
      rule("count_max", "BuildStargate", 400, 3),
      rule("not_before", "BuildStargate", 100),
    ]);
    expect(capped.map((c) => c.higherFloorElsewhere)).toEqual([false, false, false]);
    expect(capped.map((c) => c.sameTokenElsewhere)).toEqual([true, true, true]);
  });
});

describe("describeRuleFailure", () => {
  test("describeRuleFailure for all five types, none vs number, proxied", () => {
    expect(describeRuleFailure(rule("before", "BuildVoidRay", 400), 0)).toBe(
      "Needs at least 1 Void Ray before 6:40 — this game had none.",
    );
    expect(describeRuleFailure(rule("not_before", "BuildRoboticsFacility", 240), 1)).toBe(
      "Needs no Robotics Facility before 4:00 — this game had 1.",
    );
    expect(describeRuleFailure(rule("count_min", "BuildVoidRay", 600, 4), 1)).toBe(
      "Needs at least 4 Void Rays before 10:00 — this game had 1.",
    );
    expect(describeRuleFailure(rule("count_max", "BuildStargate", 360, 1), 3)).toBe(
      "Needs at most 1 Stargate before 6:00 — this game had 3.",
    );
    expect(describeRuleFailure(rule("count_exact", "BuildStargate", 300, 2), 3)).toBe(
      "Needs exactly 2 Stargates before 5:00 — this game had 3.",
    );
    expect(describeRuleFailure(rule("count_exact", "BuildStargate", 300, 2), 0)).toBe(
      "Needs exactly 2 Stargates before 5:00 — this game had none.",
    );
    expect(describeRuleFailure(rule("before", "BuildBarracks", 120, 1, true), 0)).toBe(
      "Needs at least 1 proxied Barracks before 2:00 — this game had none.",
    );
    expect(describeRuleFailure(rule("count_max", "BuildStargate", 300, 0), 1)).toBe(
      "Needs no Stargate before 5:00 — this game had 1.",
    );
  });
});

describe("legend, toasts and glyphs", () => {
  test("duplicate toast names the humanised entity", () => {
    expect(duplicateRuleToast("BuildVoidRay")).toBe(
      "Void Ray is already in your rules. Change its number there to require more.",
    );
    expect(duplicateRuleToast("BuildStargate")).toBe(
      "Stargate is already in your rules. Change its number there to require more.",
    );
  });

  test("legend lists the four quantities, the time and proxy", () => {
    expect(RULES_LEGEND.map((e) => e.term)).toEqual([
      "At least 2", "Exactly 2", "At most 2", "None", "before 4:20", "Only count proxied",
    ]);
    expect(RULES_LEGEND[5].detail).toMatch(/^Counts only buildings placed more than 50 world units/);
  });

  test("no copy output contains ≥ ≤ = ✓ ✗ ⚙", () => {
    const outputs: string[] = [RULES_LEGEND_FOOTER, duplicateRuleToast("BuildStargate")];
    for (const e of RULES_LEGEND) outputs.push(e.term, e.detail);
    const names = ["BuildStargate", "ResearchBlink", "BuildBarracks", "", "Bad Name"];
    for (const type of ["before", "count_min", "count_exact", "count_max", "not_before"] as const) {
      for (const name of names) {
        for (const n of [0, 1, 2, 5]) {
          for (const proxy of [false, true]) {
            const r = rule(type, name, 245, n, proxy);
            outputs.push(describeRule(r), ruleReadoutText(r), describeRuleFailure(r, n));
            const ctx = { sameTokenElsewhere: true, higherFloorElsewhere: true };
            outputs.push(ruleReadoutText(r, ctx));
          }
        }
      }
    }
    for (const text of outputs) expect(text).not.toMatch(GLYPHS);
  });
});

describe("review follow-ups", () => {
  test("names lower-case and engine-only tokens the way the game does", () => {
    expect(humanizeRuleEntity("Researchzerglingmovementspeed")).toBe("Metabolic Boost");
    expect(humanizeRuleEntity("Buildzerglingmovementspeed")).toBe("Metabolic Boost");
    expect(humanizeRuleEntity("Buildoverlordspeed")).toBe("Pneumatized Carapace");
    expect(humanizeRuleEntity("Researchzerglingattackspeed")).toBe("Adrenal Glands");
    expect(humanizeRuleEntity("ResearchWarpGateResearch")).toBe("Warp Gate");
    expect(humanizeRuleEntity("ResearchBlinkTech")).toBe("Blink");
    expect(humanizeRuleEntity("BuildHellionTank")).toBe("Hellbat");
    expect(humanizeRuleEntity("Buildsomethingnew")).toBe("Somethingnew");
  });

  test("treats verb-less upgrades as research", () => {
    const boost = rule("before", "Buildzerglingmovementspeed", 170);
    expect(describeRule(boost)).toBe("at least 1 Metabolic Boost research before 2:50");
    expect(ruleReadoutText(boost)).toBe(
      "Passes when Metabolic Boost research starts before 2:50.",
    );
  });

  test("a higher count due EARLIER covers the 'At least 1' rule, so no deadline note", () => {
    const rules = [
      rule("before", "BuildStargate", 300),
      rule("count_min", "BuildStargate", 240, 2),
    ];
    const [first] = ruleContexts(rules);
    expect(first.higherFloorElsewhere).toBe(false);
    expect(ruleReadoutText(rules[0], first)).not.toContain("first one's deadline");
    // Different proxy scope: a proxied count says nothing about all Barracks.
    const rax = [
      rule("before", "BuildBarracks", 60),
      rule("count_min", "BuildBarracks", 120, 2, true),
    ];
    expect(ruleContexts(rax)[0].higherFloorElsewhere).toBe(false);
  });
});

describe("read-only rules summary", () => {
  test("each rule type lands in the right list with the legend's words", () => {
    const cases: Array<[BuildRule, string, string]> = [
      [rule("before", "BuildVoidRay", 400), "must", "At least 1 Void Ray before 6:40"],
      [rule("count_min", "BuildVoidRay", 600, 4), "must", "At least 4 Void Rays before 10:00"],
      [rule("count_exact", "BuildStargate", 300, 2), "must", "Exactly 2 Stargates before 5:00"],
      [rule("count_exact", "BuildStargate", 300, 0), "mustNot", "No Stargate before 5:00"],
      [rule("not_before", "BuildRoboticsFacility", 240), "mustNot", "No Robotics Facility before 4:00"],
      [rule("count_max", "BuildRoboticsFacility", 260, 0), "mustNot", "No Robotics Facility before 4:20"],
      [rule("count_max", "BuildStargate", 360, 1), "limit", "At most 1 Stargate before 6:00"],
      [rule("count_max", "TrainPhoenix", 300, 2), "limit", "At most 2 Phoenixes before 5:00"],
      [rule("before", "ResearchBlink", 425), "must", "Blink research before 7:05"],
      [rule("before", "BuildGateway", 105, 1, true), "must", "At least 1 Gateway before 1:45, proxied"],
    ];
    for (const [r, group, text] of cases) {
      expect({ text: ruleSummaryText(r), group: ruleSummaryGroup(r) }).toEqual({ text, group });
      expect(ruleSummaryText(r)).not.toMatch(GLYPHS);
    }
  });

  test("count_max 0 is listed under Must not have, never as a count of 1", () => {
    const parts = ruleSummaryParts(rule("count_max", "BuildRoboticsFacility", 260, 0));
    expect(parts).toEqual({ quantity: "No", entity: "Robotics Facility", time: "4:20" });
    expect(ruleSummaryText(rule("count_max", "BuildRoboticsFacility", 260, 0))).not.toContain("1");
  });

  test("proxy rules never repeat 'proxied' in the entity (the badge says it)", () => {
    expect(ruleSummaryParts(rule("count_min", "BuildGateway", 120, 2, true))).toEqual({
      quantity: "At least 2",
      entity: "Gateways",
      time: "2:00",
    });
  });

  test("groups keep not_before rules and sort each list by deadline", () => {
    const rules = [
      rule("count_min", "BuildVoidRay", 600, 4),
      rule("not_before", "BuildRoboticsFacility", 240),
      rule("before", "BuildStargate", 210),
      rule("count_max", "BuildStargate", 360, 1),
      rule("count_max", "BuildTwilightCouncil", 300, 0),
      rule("before", "", 100),
    ];
    const groups = groupRulesForSummary(rules);
    expect(groups.must.map((r) => r.name)).toEqual(["BuildStargate", "BuildVoidRay"]);
    expect(groups.mustNot.map((r) => r.name)).toEqual([
      "BuildRoboticsFacility",
      "BuildTwilightCouncil",
    ]);
    expect(groups.limit.map((r) => r.name)).toEqual(["BuildStargate"]);
    expect(ruleSummaryGroup(rule("before", "", 100))).toBeNull();
  });
});
