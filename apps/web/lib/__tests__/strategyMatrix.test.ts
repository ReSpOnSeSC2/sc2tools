import { describe, expect, it } from "vitest";
import { defaultMatrixRace, matrixAxes, matrixCellKey, matrixCellStyle } from "../strategyMatrix";
describe("matchup-scoped strategy matrix", () => {
  it("uses actual volume and keeps ties/absent race evidence at All", () => {
    const base = { my_build: "Build", opp_strat: "Opener", total: 9 };
    expect(defaultMatrixRace([{ ...base, myMatchups: { P: 5, T: 2, Z: 2 } }])).toBe("P");
    expect(defaultMatrixRace([{ ...base, myMatchups: { P: 4, T: 4, Z: 1 } }])).toBe("all");
    expect(defaultMatrixRace([base])).toBe("all");
  });
  it("sorts axes by visible volume or alphabetically, dropping zero rows", () => {
    const rows = [{ my_build: "A", opp_strat: "First", total: 2 }, { my_build: "Z", opp_strat: "Last", total: 9 }, { my_build: "Empty", opp_strat: "Empty", total: 0 }];
    expect(matrixAxes(rows, "games")).toEqual({ builds: ["Z", "A"], strategies: ["Last", "First"] });
    expect(matrixAxes(rows, "az")).toEqual({ builds: ["A", "Z"], strategies: ["First", "Last"] });
    expect(matrixCellKey("A|B", "C")).not.toBe(matrixCellKey("A", "B|C"));
  });
  it("keeps both ramp ends and intermediate samples above 4.5:1 in both themes", () => {
    // Compute WCAG contrast from the actual emitted CSS, independently of the
    // helper's reported contrast, including rounded alpha and chosen text color.
    const luminance = (channels: number[]) => channels.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4)).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    for (const surface of [[255, 255, 255], [12, 16, 23]] as const) for (let rate = 0; rate <= 100; rate++) for (let n = 1; n <= 20; n++) {
      const style = matrixCellStyle(rate / 100, n, 3, surface);
      const values = style.backgroundColor.match(/[\d.]+/g)!.map(Number), alpha = values[3];
      const background = values.slice(0, 3).map((value, i) => value * alpha + surface[i] * (1 - alpha));
      const text = [1, 3, 5].map(i => parseInt(style.color.slice(i, i + 2), 16));
      const a = luminance(background), b = luminance(text);
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5);
      expect(style.contrast).toBeGreaterThanOrEqual(4.5); expect(style.alpha).toBeGreaterThanOrEqual(.35); expect(style.alpha).toBeLessThanOrEqual(1);
      expect(style).not.toHaveProperty("opacity");
    }
  });
  it("bounds invalid measurements without invalid CSS or an unbounded search", () => {
    const style = matrixCellStyle(NaN, Infinity, NaN, [255, 255, 255]);
    expect(style.backgroundColor).not.toMatch(/NaN|Infinity/); expect(style.contrast).toBeGreaterThanOrEqual(4.5);
  });
  it("accepts the current themed ramp without altering the established contrast/alpha selection", () => {
    const style = matrixCellStyle(.475, 5, 3, [255, 255, 255], () => [143, 92, 12]);
    expect(style.backgroundColor).toMatch(/^rgb\(143 92 12 \/ /);
    expect(style.contrast).toBeGreaterThanOrEqual(4.5); expect(style).not.toHaveProperty("opacity");
  });
});
