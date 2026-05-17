import { describe, expect, it } from "vitest";
import { getIconPath } from "@/lib/sc2-icons";

/**
 * Pins the sc2reader unit-name variants that ship inside
 * macroBreakdown unit_timeline payloads. These are the names that
 * fall through from the per-game scouting envelope into the
 * composition strip on the opponent profile — when one doesn't
 * resolve the strip renders a "LUR" / "OVE" text badge instead of
 * the icon (visual regression caught in the field for Lurker).
 */
describe("sc2-icons — sc2reader unit variants", () => {
  it("resolves Lurker variants to the same lurker PNG", () => {
    const expected = "/icons/sc2/units/lurker.png";
    expect(getIconPath("Lurker", "unit")).toBe(expected);
    expect(getIconPath("LurkerMP", "unit")).toBe(expected);
    expect(getIconPath("LurkerMPBurrowed", "unit")).toBe(expected);
    expect(getIconPath("LurkerMPEgg", "unit")).toBe(expected);
  });

  it("resolves cocoon / morph variants onto their parent unit PNG", () => {
    expect(getIconPath("BroodLordCocoon", "unit")).toBe(
      "/icons/sc2/units/broodlord.png",
    );
    expect(getIconPath("BanelingCocoon", "unit")).toBe(
      "/icons/sc2/units/baneling.png",
    );
    expect(getIconPath("RavagerCocoon", "unit")).toBe(
      "/icons/sc2/units/ravager.png",
    );
  });

  it("resolves Overlord variants to the overlord PNG", () => {
    expect(getIconPath("Overlord", "unit")).toBe(
      "/icons/sc2/units/overlord.png",
    );
    expect(getIconPath("OverlordTransport", "unit")).toBe(
      "/icons/sc2/units/overlord.png",
    );
    expect(getIconPath("OverlordCocoon", "unit")).toBe(
      "/icons/sc2/units/overlord.png",
    );
  });
});
