// Colorblind-safe palette for the snapshot charts. Each verdict
// gets a hue AND a glyph so the dual encoding survives both
// deuteranopia and protanopia. The icon mapping is consumed by
// PositionTimeline + InflectionCallout — keep them in sync.

import type { SnapshotVerdict } from "./snapshotTypes";

export const VERDICT_COLORS: Record<SnapshotVerdict, string> = {
  winning: "#22c55e",
  likely_winning: "#4ade80",
  neutral: "#9aa3b2",
  likely_losing: "#fb923c",
  losing: "#ef4444",
  unknown: "#3a4252",
};

export const VERDICT_LABELS: Record<SnapshotVerdict, string> = {
  winning: "Winning",
  likely_winning: "Likely winning",
  neutral: "Neutral",
  likely_losing: "Likely losing",
  losing: "Losing",
  unknown: "Unknown",
};

export const VERDICT_GLYPHS: Record<SnapshotVerdict, string> = {
  winning: "▲",
  likely_winning: "△",
  neutral: "■",
  likely_losing: "▽",
  losing: "▼",
  unknown: "·",
};

// Recharts ribbon palette. Stay below 30% opacity so the user
// line + opponent line read clearly on top of stacked ribbons.
export const RIBBON_WINNER = "rgba(34, 197, 94, 0.18)";
export const RIBBON_LOSER = "rgba(239, 68, 68, 0.18)";
export const RIBBON_WINNER_STROKE = "rgba(34, 197, 94, 0.55)";
export const RIBBON_LOSER_STROKE = "rgba(239, 68, 68, 0.55)";

export const USER_LINE = "#fbbf24";
export const OPP_LINE = "#a78bfa";
export const GRID_LINE = "#1f2533";
export const AXIS_LINE = "#6b7280";

export const SEVERITY_COLORS: Record<"low" | "medium" | "high", string> = {
  low: "#9aa3b2",
  medium: "#fb923c",
  high: "#ef4444",
};

export function verdictColor(v: SnapshotVerdict): string {
  return VERDICT_COLORS[v] || VERDICT_COLORS.unknown;
}
