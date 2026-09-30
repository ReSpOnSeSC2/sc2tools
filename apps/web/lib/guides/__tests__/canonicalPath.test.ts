import { describe, expect, test } from "vitest";
import { lowercaseGuidePath } from "@/lib/guides/canonicalPath";
import { GUIDE_MATCHUPS, GUIDES_BASE_PATH } from "@/lib/guides/slugs";

describe("lowercaseGuidePath", () => {
  test("lowercases a mixed-case guide path whose lowercase form is a guide URL", () => {
    expect(lowercaseGuidePath("/guides/PvZ")).toBe("/guides/pvz");
    expect(lowercaseGuidePath("/guides/PvZ/Stargate-into-Glaives")).toBe("/guides/pvz/stargate-into-glaives");
    expect(lowercaseGuidePath("/guides/ZVP/counter/12-Pool")).toBe("/guides/zvp/counter/12-pool");
    expect(lowercaseGuidePath("/guides/maps/Old-Sun-Temple")).toBe("/guides/maps/old-sun-temple");
    expect(lowercaseGuidePath("/guides/Maps/old-sun-temple")).toBe("/guides/maps/old-sun-temple");
  });

  test("is null for a path that is already canonical", () => {
    expect(lowercaseGuidePath("/guides/pvz")).toBeNull();
    expect(lowercaseGuidePath("/guides/pvz/stargate-into-glaives")).toBeNull();
    expect(lowercaseGuidePath("/guides/maps/old-sun-temple")).toBeNull();
  });

  test("is null when no lowercase form could be a guide URL (the page 404s instead)", () => {
    expect(lowercaseGuidePath("/guides/PvX")).toBeNull();
    expect(lowercaseGuidePath("/guides/Not-A-Matchup/x")).toBeNull();
    expect(lowercaseGuidePath("/guides/PvZ/Stargate Into Glaives")).toBeNull();
    expect(lowercaseGuidePath(`/guides/PvZ/${"A".repeat(81)}`)).toBeNull();
    expect(lowercaseGuidePath("/Guides/pvz")).toBeNull();
    expect(lowercaseGuidePath("/other/PvZ")).toBeNull();
  });
});

describe("lowercaseGuidePath stays in step with lib/guides/slugs.ts", () => {
  test("accepts exactly the nine GUIDE_MATCHUPS as the first segment", () => {
    const races = ["P", "T", "Z", "R", "X"];
    const all = races.flatMap((a) => races.map((b) => `${a}v${b}`));
    const accepted = all.filter((mu) => lowercaseGuidePath(`${GUIDES_BASE_PATH}/${mu}`) !== null);
    expect(accepted.sort()).toEqual([...GUIDE_MATCHUPS].sort());
  });
});
