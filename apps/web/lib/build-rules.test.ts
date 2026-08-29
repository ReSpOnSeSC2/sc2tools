import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cycleRuleType,
  eventsToSourceRows,
  formatRule,
  ruleFromEvent,
  sanitiseRule,
  PROXY_ELIGIBLE_BUILDINGS,
  type BuildRule,
} from "./build-rules";
import { rulesToSignature, signatureToRows } from "./build-events";

describe("formatRule", () => {
  test("renders a before-rule with verb-prefix stripped and m:ss time", () => {
    const r: BuildRule = {
      type: "before",
      name: "BuildStargate",
      time_lt: 210,
    };
    expect(formatRule(r)).toEqual({
      prefix: "",
      entity: "Stargate",
      connector: "before",
      time: "3:30",
    });
  });

  test("describes not_before rules without the ambiguous 'NOT by' wording", () => {
    const r: BuildRule = {
      type: "not_before",
      name: "BuildRoboticsFacility",
      time_lt: 240,
    };
    expect(formatRule(r)).toEqual({
      prefix: "",
      entity: "Robotics Facility",
      connector: "must not be built before",
      time: "4:00",
    });
  });

  test("renders count_max with ≤ and 'by' connector", () => {
    const r: BuildRule = {
      type: "count_max",
      name: "TrainPhoenix",
      time_lt: 300,
      count: 2,
    };
    expect(formatRule(r)).toEqual({
      prefix: "≤ 2 ",
      entity: "Phoenix",
      connector: "by",
      time: "5:00",
    });
  });

  test("renders count_exact with = and 'by' connector", () => {
    const r: BuildRule = {
      type: "count_exact",
      name: "BuildStargate",
      time_lt: 210,
      count: 1,
    };
    expect(formatRule(r)).toEqual({
      prefix: "= 1 ",
      entity: "Stargate",
      connector: "by",
      time: "3:30",
    });
  });

  test("renders count_min with ≥ and 'by' connector", () => {
    const r: BuildRule = {
      type: "count_min",
      name: "BuildStalker",
      time_lt: 240,
      count: 3,
    };
    expect(formatRule(r)).toEqual({
      prefix: "≥ 3 ",
      entity: "Stalker",
      connector: "by",
      time: "4:00",
    });
  });

  test("handles Research/Morph verbs and zero-padded seconds", () => {
    expect(formatRule({ type: "before", name: "ResearchBlink", time_lt: 425 })).toEqual({
      prefix: "",
      entity: "Blink",
      connector: "before",
      time: "7:05",
    });
    expect(
      formatRule({ type: "before", name: "MorphBaneling", time_lt: 180 }),
    ).toEqual({
      prefix: "",
      entity: "Baneling",
      connector: "before",
      time: "3:00",
    });
  });

  test("falls back to humanised camelCase when no verb prefix is present", () => {
    expect(
      formatRule({ type: "before", name: "Stargate", time_lt: 210 }),
    ).toEqual({
      prefix: "",
      entity: "Stargate",
      connector: "before",
      time: "3:30",
    });
  });
});

describe("proxy build rules", () => {
  test("save-from-replay carries canonical proxy evidence into the rule", () => {
    const event = {
      time: 90,
      name: "Barracks",
      display: "Barracks",
      is_building: true,
      is_proxy: true,
    };
    expect(eventsToSourceRows([event])[0].isProxy).toBe(true);
    expect(ruleFromEvent(event)).toEqual({
      type: "before",
      name: "BuildBarracks",
      time_lt: 120,
      proxy: true,
    });
  });

  test("cycling and sanitising preserve valid proxy requirements", () => {
    const rule: BuildRule = {
      type: "before",
      name: "BuildBarracks",
      time_lt: 120,
      proxy: true,
    };
    expect(cycleRuleType(rule).proxy).toBe(true);
    expect(sanitiseRule(rule)).toEqual(rule);
    expect(formatRule(rule).entity).toBe("Proxy Barracks");
  });

  test("sanitising drops proxy from non-structure tokens", () => {
    expect(sanitiseRule({
      type: "before",
      name: "BuildMarine",
      time_lt: 120,
      proxy: true,
    })).toEqual({ type: "before", name: "BuildMarine", time_lt: 120 });
    for (const name of [
      "BuildNydusWorm",
      "BuildSupplyDepot",
      "BuildShieldBattery",
      "BuildBarracksFlying",
      "BuildWarpGate",
      "BuildLair",
    ]) {
      expect(sanitiseRule({
        type: "before", name, time_lt: 120, proxy: true,
      })).toEqual({ type: "before", name, time_lt: 120 });
    }
    expect(sanitiseRule({
      type: "before",
      name: "BuildNydusNetwork",
      time_lt: 120,
      proxy: true,
    })).toMatchObject({ proxy: true });
  });

  test("web proxy eligibility exactly matches the local JSON schema", () => {
    const schema = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "../replay-engine/data/custom_builds.schema.json",
    ), "utf8"));
    const schemaNames = schema.definitions.proxyStructureName.enum
      .map((token: string) => token.slice("Build".length))
      .sort();
    expect([...PROXY_ELIGIBLE_BUILDINGS].sort()).toEqual(schemaNames);
  });

  test("community rule timeline retains the proxy label", () => {
    const signature = rulesToSignature([{
      type: "before",
      name: "BuildGateway",
      time_lt: 100,
      proxy: true,
    }]);
    expect(signature[0].proxy).toBe(true);
    expect(signatureToRows(signature)[0].isProxy).toBe(true);
  });
});
