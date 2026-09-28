import { describe, expect, it } from "vitest";
import { verifiedLabel, verifiedRegionsLabel, type ReviewerVerified } from "@/lib/reviews";

const GM = { id: 6, label: "Grandmaster" };
const MASTER = { id: 5, label: "Master" };

describe("reviewer league labels", () => {
  it("groups regions on the same league", () => {
    const v: ReviewerVerified = {
      band: GM,
      race: "Protoss",
      mmr: 5400,
      regions: [
        { region: "NA", band: GM, race: "Protoss" },
        { region: "EU", band: GM, race: "Protoss" },
      ],
    };
    expect(verifiedRegionsLabel(v)).toBe("Grandmaster Protoss (NA, EU)");
    expect(verifiedLabel(v)).toBe("Grandmaster Protoss");
  });

  it("names each region's league when they differ", () => {
    const v: ReviewerVerified = {
      band: GM,
      race: "Protoss",
      mmr: 5400,
      regions: [
        { region: "NA", band: GM, race: "Protoss" },
        { region: "EU", band: MASTER, race: "Zerg" },
        { region: "KR", band: MASTER, race: "Zerg" },
      ],
    };
    expect(verifiedRegionsLabel(v)).toBe("Grandmaster Protoss (NA) · Master Zerg (EU, KR)");
  });

  it("falls back to the overall league without regions, and to Unverified without a league", () => {
    const older: ReviewerVerified = { band: MASTER, race: "Terran", mmr: 4800 };
    const noRegions: ReviewerVerified = { band: MASTER, race: null, mmr: null, regions: [] };
    expect(verifiedRegionsLabel(older)).toBe("Master Terran");
    expect(verifiedRegionsLabel(noRegions)).toBe("Master");
    expect(verifiedRegionsLabel(null)).toBe("Unverified");
  });
});
