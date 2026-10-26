// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, type BadgeVariant } from "../../components/ui/Badge";
import { contrastMatrix, contrastRatio, contrastTable, contrastThemes } from "../../scripts/contrast-tokens.mjs";

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
  const variants: BadgeVariant[] = ["neutral", "accent", "cyan", "signal", "success", "warning", "danger"];
  for (const variant of variants) {
    // Read the real component's classes, rather than mirroring its tint values.
    const html = renderToStaticMarkup(createElement(Badge, { variant }, "Badge"));
    const classes = html.match(/class="([^"]*)"/)![1].split(/\s+/);
    const background = classes.map(value => value.match(/^bg-([a-z-]+)(?:\/(\d+))?$/)).find(Boolean)!;
    const foreground = classes.map(value => value.match(/^text-([a-z-]+)$/)).find(Boolean)![1];
    const ink = foreground === "accent" ? "accent-ink" : foreground;
    const fill = background[1] === "danger" ? "danger-fill" : background[1];
    const alpha = background[2] ? Number(background[2]) / 100 : 1;
    for (const [theme, palette] of Object.entries(contrastThemes(css)) as [string, Record<string, number[]>][]) {
      for (const parent of ["bg", "bg-surface", "bg-elevated"]) {
        it(`${theme}: ${variant} Badge over ${parent} >= 4.5:1`, () => {
          const composite = palette[fill].map((channel, index) => channel * alpha + palette[parent][index] * (1 - alpha));
          expect(contrastRatio(palette[ink], composite)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});
