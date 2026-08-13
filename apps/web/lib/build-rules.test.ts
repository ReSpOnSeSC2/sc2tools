import { describe, expect, test } from "vitest";
import { formatRule, type BuildRule } from "./build-rules";

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
