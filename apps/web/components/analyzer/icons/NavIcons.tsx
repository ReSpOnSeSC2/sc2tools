"use client";

import type { SVGProps } from "react";

// Custom SVG icon set for the analyzer dashboard sidebar nav. Each
// icon is hand-drawn (not vendor lucide) and tuned to a Starcraft-
// tactical visual language:
//
//   Opponents    target-lock corner brackets framing a soldier head
//   Strategies   crossed psi-blades with diamond emitter pommels
//   Trends       HUD line graph rising across L-shaped axes
//   Maps         3-hex honeycomb with an objective marker
//   Builds       Protoss-pylon hex outline with warp-energy bars
//   Arcade       tactical scope reticle with compass ticks
//
// All six share: 24x24 viewBox, currentColor stroke, 1.75 stroke
// width, round caps + joins. That keeps them visually cohesive with
// each other AND with the remaining lucide icons we still use in
// other surfaces (settings cog, chevron, etc.). Filled accents use
// `fill="currentColor"` so the colour follows the parent's text
// colour rule.

type IconProps = SVGProps<SVGSVGElement>;

const SVG_BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * Opponents — four tactical-HUD corner brackets framing a simple
 * head + shoulders silhouette. Reads as "target acquired on enemy
 * player profile" at all sizes.
 */
export function OpponentsIcon(props: IconProps) {
  return (
    <svg {...SVG_BASE} {...props}>
      <path d="M4 8V4h4" />
      <path d="M20 8V4h-4" />
      <path d="M4 16v4h4" />
      <path d="M20 16v4h-4" />
      <circle cx="12" cy="10" r="2.25" />
      <path d="M7.5 17.5c0-2.49 2.01-4.5 4.5-4.5s4.5 2.01 4.5 4.5" />
    </svg>
  );
}

/**
 * Strategies — two crossed energy-blade lines with diamond-shaped
 * emitter pommels at the handle ends (bottom-left & bottom-right).
 * The handles are kept at the bottom corners to match the
 * universal "crossed swords" reading; the diamond pommels +
 * `strokeLinecap=round` blade tips give it a sci-fi rather than
 * medieval feel.
 */
export function StrategiesIcon(props: IconProps) {
  return (
    <svg {...SVG_BASE} {...props}>
      <path d="M5.5 5.5l12.5 12.5" />
      <path d="M18.5 5.5l-12.5 12.5" />
      <path d="M17 16.5l1.5 1.5 1.5 -1.5 -1.5 -1.5z" />
      <path d="M4 16.5l1.5 1.5 1.5 -1.5 -1.5 -1.5z" />
    </svg>
  );
}

/**
 * Trends — L-shaped axes with a rising 4-segment zigzag and three
 * data dots. The dots sit at the segment vertices so the eye reads
 * "discrete observations connected by a trendline", not just a
 * decorative wave.
 */
export function TrendsIcon(props: IconProps) {
  return (
    <svg {...SVG_BASE} {...props}>
      <path d="M4 4v16h16" />
      <path d="M7 16l3.5 -4 4 2 5.5 -7" />
      <circle cx="7" cy="16" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="14" r="1" fill="currentColor" stroke="none" />
      <circle cx="20" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Maps — three pointy-top hexagons tiled into a Y-shaped
 * honeycomb (one above two), sharing a single vertex at (12, 9.5).
 * A small filled dot in the upper hex acts as the objective /
 * focus marker. Hexagons are the dominant SC2 minimap-and-grid
 * motif, so the icon reads as "tactical board" rather than
 * "geographic map".
 */
export function MapsIcon(props: IconProps) {
  return (
    <svg {...SVG_BASE} {...props}>
      <path d="M12 4.5l2.17 1.25v2.5L12 9.5 9.83 8.25v-2.5z" />
      <path d="M9.835 8.25L12 9.5v2.5L9.835 13.25 7.67 12V9.5z" />
      <path d="M14.165 8.25L16.33 9.5V12l-2.165 1.25L12 12V9.5z" />
      <circle cx="12" cy="7" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Builds — Protoss-pylon-style elongated hex outline with two
 * horizontal warp-energy bars across the middle. The hex shape
 * (pointed top + bottom, vertical sides) is the SC2 architectural
 * signature; the two interior bars read as "construction layers"
 * or "build queue stages".
 */
export function BuildsIcon(props: IconProps) {
  return (
    <svg {...SVG_BASE} {...props}>
      <path d="M12 3l5.5 4.5v9L12 21l-5.5-4.5v-9z" />
      <path d="M8 11h8" />
      <path d="M8 15h8" />
    </svg>
  );
}

/**
 * Arcade — tactical scope reticle: an outer ring with a 4-segment
 * crosshair (gap at centre), a small filled centre dot, and four
 * compass ticks at the outer ring's cardinal points. Reads as
 * "targeting HUD" — fits the arcade tab's "mini-games go deeper
 * than the charts" framing better than a gamepad would, and stays
 * inside the SC2 visual language.
 */
export function ArcadeIcon(props: IconProps) {
  return (
    <svg {...SVG_BASE} {...props}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 6.5v2.5" />
      <path d="M12 15v2.5" />
      <path d="M6.5 12h2.5" />
      <path d="M15 12h2.5" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <path d="M12 2.5v1.5" />
      <path d="M12 20v1.5" />
      <path d="M2.5 12h1.5" />
      <path d="M20 12h1.5" />
    </svg>
  );
}
