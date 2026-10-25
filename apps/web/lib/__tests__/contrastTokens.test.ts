// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastMatrix, contrastRatio, contrastTable } from "../../scripts/contrast-tokens.mjs";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
describe("theme contrast contracts", () => {
  it("uses the standard luminance endpoints", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBe(21);
    expect(contrastRatio([20, 20, 20], [20, 20, 20])).toBe(1);
  });
  for (const row of contrastMatrix(css)) {
    it(`${row.theme}: ${row.foreground} on ${row.background} >= ${row.minimum}:1`, () => {
      expect(row.ratio).toBeGreaterThanOrEqual(row.minimum);
    });
  }
  it("generates the documentation table from the same complete matrix", () => {
    expect(contrastTable(css)).toContain("Replay on light");
    expect(contrastTable(css)).not.toMatch(/NaN|Infinity/);
  });
});
