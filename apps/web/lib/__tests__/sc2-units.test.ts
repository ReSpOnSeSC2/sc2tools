import { describe, expect, it } from "vitest";
import { getUnitCost } from "../sc2-units";

describe("5.0.16b live unit-cost catalog", () => {
  it("uses the hotfixed Terran town-hall costs and Ghost supply", () => {
    expect(getUnitCost("CommandCenter")).toMatchObject({ m: 300, g: 0 });
    expect(getUnitCost("PlanetaryFortress")).toMatchObject({
      m: 250,
      g: 150,
    });
    expect(getUnitCost("Ghost")).toMatchObject({ m: 150, g: 125, s: 2 });
  });
});
