"use client";

import { useMemo, type CSSProperties } from "react";
import { DARK_FALLBACK, useChartTheme, useReducedMotion } from "@/lib/useChartTheme";
import { wrRamp, type WrRampPalette } from "@/lib/format";

export const CHART_SMALL_SAMPLE = 20;
export function isLowSample(n: number | null | undefined) { return n == null || !Number.isFinite(n) || n < CHART_SMALL_SAMPLE; }
const rgb = (value: string): [number, number, number] => {
  const channels = value.match(/[\d.]+/g)?.map(Number);
  return channels?.length === 3 ? [channels[0], channels[1], channels[2]] : [159, 173, 185];
};

/** Resolves the existing theme observer once; older hook consumers keep their
 * original fields while new charts share palette, axes and sample semantics. */
export function useChartKit() {
  const tokens = useChartTheme(), reducedMotion = useReducedMotion();
  return useMemo(() => {
    const palette = tokens.chart || DARK_FALLBACK.chart!;
    const ramp: WrRampPalette = { red: rgb(palette.red), amber: rgb(palette.amber), green: rgb(palette.green) };
    const tooltipStyle: CSSProperties = { background: tokens.bgElevated, color: tokens.text, border: `1px solid ${tokens.border}`, borderRadius: 8, fontSize: 12 };
    return { tokens, reducedMotion, grid: tokens.border, axis: tokens.textMuted,
      tickStyle: { fontSize: 12 as const, fill: tokens.textMuted }, tooltipStyle, series: palette.series, lowSample: palette.lowSample,
      wrRamp: (rate: number) => wrRamp(rate, ramp),
      wrColor: (rate: number | null | undefined, decided: number) => rate == null || !Number.isFinite(rate) || isLowSample(decided)
        ? palette.lowSample : `rgb(${wrRamp(rate, ramp).join(" ")})`,
    };
  }, [tokens, reducedMotion]);
}

export type ChartSeries = { color: string; strokeDasharray: string | undefined };
/** Sort before collision resolution so input order cannot reassign identities.
 * Beyond eight colors, dashes and visible labels continue distinguishing lines. */
export function assignChartSeries(names: readonly string[], palette: readonly string[]): Map<string, ChartSeries> {
  const used = new Set<number>(), result = new Map<string, ChartSeries>();
  const colors = palette.length ? palette : DARK_FALLBACK.chart!.series;
  [...new Set(names)].sort().forEach((name, index) => {
    let hash = 0; for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    let slot = hash % colors.length;
    for (let attempt = 0; used.has(slot) && attempt < colors.length; attempt += 1) slot = (slot + 1) % colors.length;
    used.add(slot);
    result.set(name, { color: colors[slot], strokeDasharray: index < colors.length ? undefined : index < colors.length * 2 ? "6 3" : "2 3" });
  });
  return result;
}
