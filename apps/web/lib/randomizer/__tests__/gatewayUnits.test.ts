import { describe, expect, it } from "vitest";
import {
  defaultGatewayUnits,
  inferGatewayCount,
} from "@/lib/randomizer/gatewayUnits";

describe("defaultGatewayUnits", () => {
  it("creates an equal-weight all-unit default", () => {
    expect(defaultGatewayUnits(2)).toEqual({
      gateCount: 2,
      useCustomWeights: false,
      units: [
        { id: "zealot", weight: 1 },
        { id: "stalker", weight: 1 },
        { id: "sentry", weight: 1 },
        { id: "adept", weight: 1 },
      ],
    });
  });
});

describe("inferGatewayCount", () => {
  it("uses matchup defaults", () => {
    expect(inferGatewayCount("PvP", "Macro Opener")).toBe(2);
    expect(inferGatewayCount("PvT", "Macro Opener")).toBe(1);
    expect(inferGatewayCount("PvZ", "Macro Opener")).toBe(1);
  });

  it("prefers explicit 1 Gate / 2 Gate names in common spellings", () => {
    expect(inferGatewayCount("PvP", "PvP - 1 Gate Expand")).toBe(1);
    expect(inferGatewayCount("PvT", "PvT - 2-Gate Blink")).toBe(2);
    expect(inferGatewayCount("PvZ", "2Gateway Pressure")).toBe(2);
  });
});
