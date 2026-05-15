// Colorblind-safe palette for win-rate cells (composition matchup
// matrix). Each band gets a color AND a glyph so the dual encoding
// survives deuteranopia / protanopia. Cells under the confidence
// threshold get a hashed pattern.

export type WinRateBucket = "favorable" | "neutral" | "unfavorable" | "insufficient";

export const WR_COLORS: Record<WinRateBucket, string> = {
  favorable: "#22c55e",
  neutral: "#9aa3b2",
  unfavorable: "#ef4444",
  insufficient: "#3a4252",
};

export const WR_GLYPHS: Record<WinRateBucket, string> = {
  favorable: "▲",
  neutral: "●",
  unfavorable: "▼",
  insufficient: "·",
};

export const WR_LABELS: Record<WinRateBucket, string> = {
  favorable: "Favorable",
  neutral: "Neutral",
  unfavorable: "Unfavorable",
  insufficient: "Low confidence",
};

export interface WinRateClassification {
  bucket: WinRateBucket;
  color: string;
  glyph: string;
  label: string;
  lowConfidence: boolean;
}

const MIN_SAMPLE_FOR_CONFIDENCE = 10;
const MAX_CI_WIDTH = 0.3;
const NEUTRAL_LO = 0.4;
const NEUTRAL_HI = 0.6;

export function classifyWinRate(
  winRate: number,
  sampleSize: number,
  ci?: [number, number],
): WinRateClassification {
  const ciWidth = ci ? Math.abs(ci[1] - ci[0]) : 0;
  const lowConfidence =
    sampleSize < MIN_SAMPLE_FOR_CONFIDENCE || (ci ? ciWidth > MAX_CI_WIDTH : false);
  if (lowConfidence) {
    return {
      bucket: "insufficient",
      color: WR_COLORS.insufficient,
      glyph: WR_GLYPHS.insufficient,
      label: WR_LABELS.insufficient,
      lowConfidence: true,
    };
  }
  if (winRate >= NEUTRAL_HI) {
    return {
      bucket: "favorable",
      color: WR_COLORS.favorable,
      glyph: WR_GLYPHS.favorable,
      label: WR_LABELS.favorable,
      lowConfidence: false,
    };
  }
  if (winRate <= NEUTRAL_LO) {
    return {
      bucket: "unfavorable",
      color: WR_COLORS.unfavorable,
      glyph: WR_GLYPHS.unfavorable,
      label: WR_LABELS.unfavorable,
      lowConfidence: false,
    };
  }
  return {
    bucket: "neutral",
    color: WR_COLORS.neutral,
    glyph: WR_GLYPHS.neutral,
    label: WR_LABELS.neutral,
    lowConfidence: false,
  };
}

export function lowConfidenceHashStyle(): React.CSSProperties {
  return {
    backgroundImage:
      "repeating-linear-gradient(45deg, rgba(154, 163, 178, 0.25) 0 6px, transparent 6px 12px)",
  };
}
