import { describe, expect, it } from "vitest";
import { fmtTick, tierLabel, METRIC_LABELS } from "../shared/snapshotTypes";

describe("fmtTick", () => {
  it("formats 0 as 0:00", () => {
    expect(fmtTick(0)).toBe("0:00");
  });
  it("formats 30 as 0:30", () => {
    expect(fmtTick(30)).toBe("0:30");
  });
  it("formats 360 as 6:00", () => {
    expect(fmtTick(360)).toBe("6:00");
  });
  it("zero-pads seconds", () => {
    expect(fmtTick(125)).toBe("2:05");
  });
});

describe("tierLabel", () => {
  it("labels tier 1 as the most specific", () => {
    expect(tierLabel(1)).toMatch(/Tier 1/);
    expect(tierLabel(1)).toMatch(/opening/i);
  });
  it("labels tier 4 as the matchup-only fallback", () => {
    expect(tierLabel(4)).toMatch(/Tier 4/);
    expect(tierLabel(4)).toMatch(/matchup only/i);
  });
});

describe("METRIC_LABELS", () => {
  it("has a label for every metric key the API ships", () => {
    const keys = ["army_value", "army_supply", "workers", "bases", "income_min", "income_gas"];
    for (const k of keys) {
      expect(METRIC_LABELS[k as keyof typeof METRIC_LABELS]).toBeDefined();
    }
  });
});
