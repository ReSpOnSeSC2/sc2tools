/**
 * Theme-aware chart token resolution.
 *
 * Chart libraries like @nivo/sankey resolve colors at render time and
 * cannot read CSS variables through Tailwind utility classes — they
 * need concrete `rgb(...)` strings. This hook reads the current
 * `[data-theme]`-driven token values off `document.documentElement` and
 * re-reads them whenever the attribute flips, so chart colors restyle
 * instantly on theme toggle without a page reload.
 *
 * Companion hook `useReducedMotion` mirrors the same shape for the
 * `prefers-reduced-motion` media query so callers can pass
 * `animate={false}` to chart libs when the user has motion turned down.
 */

import { useEffect, useState } from "react";

export type ChartThemeTokens = {
  bg: string;
  bgSurface: string;
  bgElevated: string;
  text: string;
  textMuted: string;
  textDim: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentCyan: string;
  success: string;
  warning: string;
  danger: string;
  /** Optional so older chart consumers and their token fixtures stay valid. */
  chart?: ChartPalette;
};

export type ChartPalette = { series: readonly string[]; lowSample: string; red: string; amber: string; green: string };

// SSR / first paint fallback. Values match the dark-theme defaults in
// app/globals.css so an SSR snapshot lines up with the hydrated chart.
export const DARK_FALLBACK: ChartThemeTokens = {
  bg: "rgb(6 9 14)",
  bgSurface: "rgb(12 16 23)",
  bgElevated: "rgb(17 23 32)",
  text: "rgb(231 237 240)",
  textMuted: "rgb(159 173 185)",
  textDim: "rgb(134 146 159)",
  border: "rgb(92 105 124)",
  borderStrong: "rgb(117 132 155)",
  accent: "rgb(21 125 140)",
  accentCyan: "rgb(60 224 214)",
  success: "rgb(62 200 132)",
  warning: "rgb(232 156 56)",
  danger: "rgb(255 107 107)",
  chart: { series: [[66, 190, 215], [238, 75, 43], [68, 127, 243], [233, 150, 150], [184, 249, 228], [173, 137, 245], [190, 215, 66], [192, 217, 242]].map(rgb => `rgb(${rgb.join(" ")})`),
    lowSample: "rgb(159 173 185)", red: "rgb(255 107 107)", amber: "rgb(245 184 74)", green: "rgb(62 200 132)" },
};

function readTokens(): ChartThemeTokens {
  if (typeof window === "undefined") return DARK_FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    return raw ? `rgb(${raw})` : fallback;
  };
  return {
    bg: read("--bg", DARK_FALLBACK.bg),
    bgSurface: read("--bg-surface", DARK_FALLBACK.bgSurface),
    bgElevated: read("--bg-elevated", DARK_FALLBACK.bgElevated),
    text: read("--text", DARK_FALLBACK.text),
    textMuted: read("--text-muted", DARK_FALLBACK.textMuted),
    textDim: read("--text-dim", DARK_FALLBACK.textDim),
    border: read("--border", DARK_FALLBACK.border),
    borderStrong: read("--border-strong", DARK_FALLBACK.borderStrong),
    accent: read("--accent", DARK_FALLBACK.accent),
    accentCyan: read("--accent-cyan", DARK_FALLBACK.accentCyan),
    success: read("--success", DARK_FALLBACK.success),
    warning: read("--warning", DARK_FALLBACK.warning),
    danger: read("--danger", DARK_FALLBACK.danger),
    chart: { series: Array.from({ length: 8 }, (_, index) => read(`--series-${index + 1}`, DARK_FALLBACK.chart!.series[index])),
      lowSample: read("--chart-low-sample", DARK_FALLBACK.chart!.lowSample), red: read("--chart-wr-low", DARK_FALLBACK.chart!.red),
      amber: read("--chart-wr-mid", DARK_FALLBACK.chart!.amber), green: read("--chart-wr-high", DARK_FALLBACK.chart!.green) },
  };
}

/**
 * Returns the current chart-friendly token values and re-runs whenever
 * `<html data-theme>` changes. Safe to use during SSR — falls back to
 * the dark palette until hydration.
 */
export function useChartTheme(): ChartThemeTokens {
  const [tokens, setTokens] = useState<ChartThemeTokens>(DARK_FALLBACK);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setTokens(readTokens());
    const obs = new MutationObserver(() => setTokens(readTokens()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);
  return tokens;
}

/**
 * Returns true when the user has `prefers-reduced-motion: reduce` set,
 * with live updates on preference change. SSR-safe (returns false until
 * the matchMedia listener attaches client-side).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    if (mq.addEventListener) {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    // Older Safari: addListener fallback.
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduced;
}

/**
 * Returns true when `window.matchMedia(query).matches` is true. Used by
 * the Sankey + composition tabs to swap their mobile layouts in JS
 * (the Sankey can't be rotated via CSS; the tab row needs scroll-into-
 * view behavior). SSR-safe.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    if (mq.addEventListener) {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [query]);
  return matches;
}
