import { describe, expect, it } from "vitest";
import {
  GATEWAY_UNITS,
  defaultOpeningUnits,
  gatewayUnitMeta,
  inferGatewayCount,
  isGatewayUnitId,
} from "@/lib/randomizer/gatewayUnits";

describe("Gateway unit metadata", () => {
  it("has the four fixed units in stable order with real SC2 icons", () => {
    expect(GATEWAY_UNITS.map((unit) => unit.id)).toEqual([
      "zealot",
      "stalker",
      "sentry",
      "adept",
    ]);
    for (const unit of GATEWAY_UNITS) {
      expect(unit.iconPath).toBe(`/icons/sc2/units/${unit.id}.png`);
      expect(gatewayUnitMeta(unit.id)).toBe(unit);
    }
  });

  it("strictly recognizes persisted unit ids", () => {
    expect(isGatewayUnitId("stalker")).toBe(true);
    expect(isGatewayUnitId("marine")).toBe(false);
    expect(isGatewayUnitId(null)).toBe(false);
  });

  it("creates an equal-weight all-unit default", () => {
    expect(defaultOpeningUnits(2)).toEqual({
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
