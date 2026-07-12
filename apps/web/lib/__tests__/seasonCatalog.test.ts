import { describe, expect, it } from "vitest";
import { currentSeason, seasonRange } from "../seasonCatalog";

const JULY_12_2026 = new Date("2026-07-12T16:00:00.000Z");

describe("seasonCatalog fallback", () => {
  it("keeps the last known current season at 67 on July 12, 2026", () => {
    expect(currentSeason(JULY_12_2026)).toBe(67);
  });

  it("keeps current Season 67 open through now instead of inventing Season 68", () => {
    const range = seasonRange(67, JULY_12_2026);

    expect(range.season).toBe(67);
    expect(range.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe(JULY_12_2026.toISOString());
  });
});
