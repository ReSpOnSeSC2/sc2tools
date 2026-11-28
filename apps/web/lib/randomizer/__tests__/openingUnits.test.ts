import { describe, expect, it } from "vitest";
import { OPENING_UNITS, openingUnitMeta } from "@/lib/randomizer/openingUnits";
import { OPENING_UNIT_IDS, isOpeningUnitId } from "@/lib/randomizer/types";

describe("opening unit metadata", () => {
  it("lists every race's units in canonical order with real SC2 icons", () => {
    for (const race of ["Protoss", "Terran", "Zerg"] as const) {
      expect(OPENING_UNITS.filter((unit) => unit.race === race).map((unit) => unit.id)).toEqual([...OPENING_UNIT_IDS[race]]);
    }
    for (const unit of OPENING_UNITS) {
      expect(unit.iconPath).toBe(`/icons/sc2/units/${unit.id}.png`);
      expect(openingUnitMeta(unit.id)).toBe(unit);
    }
    expect(openingUnitMeta("widowmine")).toMatchObject({ name: "Widow Mine", building: "Factory", race: "Terran" });
  });

  it("recognizes a persisted unit id for its own race only", () => {
    expect(isOpeningUnitId("stalker", "Protoss")).toBe(true);
    expect(isOpeningUnitId("marine", "Protoss")).toBe(false);
    expect(isOpeningUnitId("marine", "Terran")).toBe(true);
    expect(isOpeningUnitId("queen", "Zerg")).toBe(true);
    expect(isOpeningUnitId(null, "Zerg")).toBe(false);
  });
});
