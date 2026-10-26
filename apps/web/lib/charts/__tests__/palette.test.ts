// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, contrastThemes } from "../../../scripts/contrast-tokens.mjs";
import { DARK_FALLBACK } from "../../useChartTheme";
import { assignChartSeries } from "../theme";
import { wrRamp } from "../../format";
import { deltaE, lab } from "./colorDistance";

const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
const themes = contrastThemes(css) as Record<string, Record<string, number[]>>;
const rgb = (value: readonly number[]) => `rgb(${value.join(" ")})`;
describe("chart palette from the actual stylesheet", () => {
  it("matches the current dark fallback, including every legacy hook field", () => {
    const fields = { bg: "bg", bgSurface: "bg-surface", bgElevated: "bg-elevated", text: "text", textMuted: "text-muted", textDim: "text-dim",
      border: "border", borderStrong: "border-strong", accent: "accent", accentCyan: "accent-cyan", success: "success", warning: "warning", danger: "danger" } as const;
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) expect(DARK_FALLBACK[key]).toBe(rgb(themes.dark[fields[key]]));
    expect(DARK_FALLBACK.chart!.series).toEqual(Array.from({ length: 8 }, (_, index) => rgb(themes.dark[`series-${index + 1}`])));
    expect(DARK_FALLBACK.chart!.amber).toBe(rgb(themes.dark["chart-wr-mid"]));
    expect(DARK_FALLBACK.chart!.lowSample).toBe(rgb(themes.dark["chart-low-sample"]));
  });
  it("anchors Lab and distance to black, white and identical colors", () => {
    expect(lab([0, 0, 0])).toEqual([0, 0, 0]); expect(lab([255, 255, 255])[0]).toBeCloseTo(100, 3);
    expect(deltaE([0, 0, 0], [255, 255, 255])).toBeCloseTo(100, 3); expect(deltaE([30, 100, 200], [30, 100, 200], true)).toBe(0);
  });
  for (const [theme, palette] of Object.entries(themes)) {
    const colors = Array.from({ length: 8 }, (_, index) => palette[`series-${index + 1}`]);
    it(`${theme}: all eight marks and labels meet surface contrast`, () => {
      for (const color of colors) for (const surface of ["bg", "bg-surface", "bg-elevated"]) expect(contrastRatio(color, palette[surface])).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: every pair stays separated normally and under simulated deuteranopia`, () => {
      for (let first = 0; first < colors.length; first += 1) for (let second = first + 1; second < colors.length; second += 1) {
        expect(deltaE(colors[first], colors[second])).toBeGreaterThanOrEqual(15);
        expect(deltaE(colors[first], colors[second], true)).toBeGreaterThanOrEqual(15);
      }
    });
    it(`${theme}: every intermediate rate keeps readable text and visible fill contrast`, () => {
      const triple = (value: number[]): [number, number, number] => [value[0], value[1], value[2]];
      const ramp = { red: triple(palette["chart-wr-low"]), amber: triple(palette["chart-wr-mid"]), green: triple(palette["chart-wr-high"]) };
      for (let rate = 0; rate <= 100; rate += 1) for (const surface of ["bg", "bg-surface", "bg-elevated"]) {
        expect(contrastRatio(wrRamp(rate / 100, ramp), palette[surface])).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  it("keeps series assignments stable through reorder and distinguishes overflow with dashes", () => {
    const names = Array.from({ length: 20 }, (_, index) => `Synthetic build ${index}`), palette = DARK_FALLBACK.chart!.series;
    const first = assignChartSeries(names, palette), reordered = assignChartSeries([...names].reverse(), palette);
    expect([...first]).toEqual([...reordered]); expect(new Set([...first.values()].slice(0, 8).map(value => value.color)).size).toBe(8);
    expect([...first.values()].slice(8).every(value => Boolean(value.strokeDasharray))).toBe(true);
  });
});
