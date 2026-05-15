import { describe, expect, it } from "vitest";
import { classifyWinRate, WR_COLORS, WR_GLYPHS } from "../shared/winRateColors";

describe("classifyWinRate", () => {
  it("flags low confidence when sample size is below threshold", () => {
    const r = classifyWinRate(0.7, 5);
    expect(r.lowConfidence).toBe(true);
    expect(r.bucket).toBe("insufficient");
  });

  it("flags low confidence when CI is wider than 0.30", () => {
    const r = classifyWinRate(0.65, 50, [0.4, 0.85]);
    expect(r.lowConfidence).toBe(true);
  });

  it("classifies a high-confidence high winrate as favorable", () => {
    const r = classifyWinRate(0.7, 50, [0.6, 0.8]);
    expect(r.bucket).toBe("favorable");
    expect(r.color).toBe(WR_COLORS.favorable);
    expect(r.glyph).toBe(WR_GLYPHS.favorable);
  });

  it("classifies a low winrate as unfavorable", () => {
    const r = classifyWinRate(0.3, 50, [0.2, 0.4]);
    expect(r.bucket).toBe("unfavorable");
    expect(r.color).toBe(WR_COLORS.unfavorable);
  });

  it("classifies a middling winrate as neutral", () => {
    const r = classifyWinRate(0.5, 50, [0.4, 0.6]);
    expect(r.bucket).toBe("neutral");
  });
});
