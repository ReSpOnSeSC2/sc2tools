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
};

// SSR / first paint fallback. Values match the dark-theme defaults in
// app/globals.css so an SSR snapshot lines up with the hydrated chart.
const DARK_FALLBACK: ChartThemeTokens = {
  bg: "rgb(11 13 18)",
  bgSurface: "rgb(17 20 27)",
  bgElevated: "rgb(22 26 35)",
  text: "rgb(230 232 238)",
  textMuted: "rgb(154 163 178)",
  textDim: "rgb(107 114 128)",
  border: "rgb(31 37 51)",
  borderStrong: "rgb(42 49 66)",
  accent: "rgb(124 140 255)",
  accentCyan: "rgb(62 192 199)",
  success: "rgb(62 192 122)",
  warning: "rgb(230 180 80)",
  danger: "rgb(255 107 107)",
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
  };
}

/**
 * Returns the current chart-friendly token values and re-runs whenever
 * `<html data-theme>` changes. Safe to use during SSR — falls back to
 * the dark palette until hydration.
 */
export function useChartTheme(): ChartThemeTokens {
  const [tokens, setTokens] = useState<ChartThemeTokens>(() => readTokens());
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
