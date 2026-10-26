import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contrastThemes } from "../../../scripts/contrast-tokens.mjs";
import { isLowSample, useChartKit } from "../theme";
import { wrColor, wrRamp } from "../../format";

const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
const palettes = contrastThemes(css) as Record<string, Record<string, number[]>>;
let style: HTMLStyleElement;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
beforeEach(() => {
  style = document.createElement("style");
  style.textContent = ["dark", "light"].map(theme => `:root[data-theme="${theme}"]{${Object.entries(palettes[theme]).map(([key, value]) => `--${key}:${value.join(" ")};`).join("")}}`).join("");
  document.head.append(style); document.documentElement.dataset.theme = "dark";
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => mediaListeners.add(fn),
    removeEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => mediaListeners.delete(fn) })));
});
afterEach(() => { cleanup(); style.remove(); delete document.documentElement.dataset.theme; mediaListeners.clear(); vi.unstubAllGlobals(); });
describe("useChartKit live theme and motion", () => {
  it("resolves both real palettes and refreshes ticks, neutral and amber on theme change", async () => {
    const { result, rerender } = renderHook(useChartKit);
    expect(result.current.tickStyle.fontSize).toBe(12);
    expect(result.current.wrRamp(.475)).toEqual(palettes.dark["chart-wr-mid"]);
    const stable = result.current; rerender(); expect(result.current).toBe(stable);
    act(() => { document.documentElement.dataset.theme = "light"; });
    await waitFor(() => expect(result.current.series[0]).toBe(`rgb(${palettes.light["series-1"].join(" ")})`));
    expect(result.current.wrRamp(.475)).toEqual(palettes.light["chart-wr-mid"]);
    expect(result.current.wrColor(1, 19)).toBe(`rgb(${palettes.light["chart-low-sample"].join(" ")})`);
    expect(result.current.wrColor(1, 20)).not.toBe(result.current.lowSample);
  });
  it("follows reduced motion changes without changing the recorded values", () => {
    const { result } = renderHook(useChartKit), before = result.current.wrRamp(.5);
    act(() => { for (const listener of mediaListeners) listener({ matches: true } as MediaQueryListEvent); });
    expect(result.current.reducedMotion).toBe(true); expect(result.current.wrRamp(.5)).toEqual(before);
  });
  it("keeps unknown/19 small and20 sufficient while legacy helpers retain their thresholds/default ramp", () => {
    for (const n of [undefined, null, NaN, 0, 19]) expect(isLowSample(n)).toBe(true);
    expect(isLowSample(20)).toBe(false); expect(wrColor(.8, 2)).toBe("rgb(var(--chart-low-sample))");
    expect(wrRamp(.475)).toEqual([220, 165, 50]);
  });
});
