// Shared formatting helpers — ported from
// reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/utils.

export function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

export function pct1(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtAgo(iso: string | number | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.round(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function fmtDate(iso: string | number | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/**
 * Win-rate colour ramp. Severe scheme: deep red below 30%, deep green
 * above 65%, with a smooth red → amber → green gradient between so a
 * 50% bar never reads as "winning". Neutral grey when sample is tiny
 * (< 3 games) so a 1-0 day doesn't blare full green.
 */
export function wrColor(rate: number | null | undefined, games: number): string {
  if (rate == null || !Number.isFinite(rate) || games < 3) return "#9aa3b2";
  return wrRampHex(rate);
}

/**
 * Continuous win-rate → hex colour. Endpoints clamp at 30% / 65% so
 * differences inside the "interesting" middle band drive almost the
 * full colour range. Useful in chart cells / summary cards where the
 * caller doesn't want to think about thresholds.
 */
export function wrRampHex(rate: number): string {
  const [r, g, b] = wrRamp(rate);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Continuous win-rate → RGB triple in [0, 255]. Two-stop gradient
 * through an amber midpoint at 47.5% so the transition never collapses
 * into mud. Exported so cell-style charts (calendar, heatmap) can
 * combine the colour with their own opacity for the volume signal.
 */
export function wrRamp(rate: number): [number, number, number] {
  const RED: [number, number, number] = [180, 35, 45];
  const AMBER: [number, number, number] = [220, 165, 50];
  const GREEN: [number, number, number] = [40, 145, 75];
  const t = clamp((rate - 0.3) / (0.65 - 0.3), 0, 1);
  if (t <= 0.5) {
    const k = t / 0.5;
    return [
      Math.round(RED[0] + (AMBER[0] - RED[0]) * k),
      Math.round(RED[1] + (AMBER[1] - RED[1]) * k),
      Math.round(RED[2] + (AMBER[2] - RED[2]) * k),
    ];
  }
  const k = (t - 0.5) / 0.5;
  return [
    Math.round(AMBER[0] + (GREEN[0] - AMBER[0]) * k),
    Math.round(AMBER[1] + (GREEN[1] - AMBER[1]) * k),
    Math.round(AMBER[2] + (GREEN[2] - AMBER[2]) * k),
  ];
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

/**
 * A single discrete win-rate band: an inclusive lower / exclusive upper
 * bound (as fractions in [0, 1]), a base RGB colour, a short legend
 * label, and whether the band is surfaced in the legend ramp.
 */
export type WrTier = {
  min: number;
  max: number;
  label: string;
  rgb: [number, number, number];
  /** Surfaced as a swatch in the legend ramp (the neutral band isn't). */
  inLegend: boolean;
};

/**
 * Discrete win-rate tiers — a finer-grained alternative to the
 * continuous {@link wrRamp} for the time-of-day heatmap. Eight bands
 * carry the ramp from a heavy loss (deep red) through a neutral
 * coin-flip zone (50–65%) up to a dominant win (deep green), so the
 * legend can offer the full <10 / <25 / <35 / <50 / >65 / >75 / >90
 * spread the continuous ramp flattens at its 30 % / 65 % clamps.
 * Ordered low → high; `max` of the top band sits just past 1 so a
 * perfect 100 % win rate still lands inside it.
 */
export const WR_TIERS: ReadonlyArray<WrTier> = [
  { min: 0.0, max: 0.1, label: "<10%", rgb: [150, 25, 35], inLegend: true },
  { min: 0.1, max: 0.25, label: "<25%", rgb: [190, 54, 48], inLegend: true },
  { min: 0.25, max: 0.35, label: "<35%", rgb: [214, 110, 58], inLegend: true },
  { min: 0.35, max: 0.5, label: "<50%", rgb: [224, 168, 70], inLegend: true },
  { min: 0.5, max: 0.65, label: "50–65%", rgb: [176, 182, 120], inLegend: false },
  { min: 0.65, max: 0.75, label: ">65%", rgb: [122, 180, 96], inLegend: true },
  { min: 0.75, max: 0.9, label: ">75%", rgb: [58, 158, 84], inLegend: true },
  { min: 0.9, max: 1.01, label: ">90%", rgb: [28, 124, 62], inLegend: true },
];

/**
 * Map a win rate (fraction in [0, 1]) to its discrete {@link WrTier}.
 * Out-of-range inputs clamp to the nearest end band.
 */
export function wrTier(rate: number): WrTier {
  const r = Number.isFinite(rate) ? rate : 0;
  for (const tier of WR_TIERS) {
    if (r < tier.max) return tier;
  }
  return WR_TIERS[WR_TIERS.length - 1];
}

/**
 * Pick a legible foreground colour (near-black or white) for text laid
 * over one of the {@link WR_TIERS} swatches, via perceived luminance.
 */
export function wrTierTextColor(rgb: [number, number, number]): string {
  const [r, g, b] = rgb;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum > 150 ? "#0b0d12" : "#ffffff";
}

export function raceColour(race: string | null | undefined): string {
  const r = (race || "").charAt(0).toUpperCase();
  if (r === "T") return "#ff6b6b";
  if (r === "Z") return "#a78bfa";
  if (r === "P") return "#7c8cff";
  return "#9aa3b2";
}

export function fmtMmr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  // No thousands separator — MMR is always a 4-digit number in
  // practice and "4,955" reads less naturally than "4955" in the
  // SC2 community.
  return String(Math.round(v));
}

export function fmtMinutes(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Display modes offered by the Trends playtime summary. */
export type PlaytimeFormat =
  | "weeks"
  | "days"
  | "hours"
  | "hoursMinutes"
  | "minutesSeconds";

/** Dropdown-ready labels kept beside their stable persisted values. */
export const PLAYTIME_FORMAT_OPTIONS: ReadonlyArray<{
  value: PlaytimeFormat;
  label: string;
}> = [
  { value: "weeks", label: "Weeks" },
  { value: "days", label: "Days" },
  { value: "hours", label: "Hours" },
  { value: "hoursMinutes", label: "Hours and minutes" },
  { value: "minutesSeconds", label: "Minutes and seconds" },
];

const DECIMAL_PLAYTIME = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
const INTEGER_PLAYTIME = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

/**
 * Format a total number of in-game seconds in the unit selected on Trends.
 * Decimal-only modes retain a visible trace for tiny positive totals instead
 * of rounding them down to zero. Compound modes round at their smallest
 * displayed unit before splitting, so they never render values such as 60s.
 */
export function fmtPlaytime(
  seconds: number | null | undefined,
  format: PlaytimeFormat,
): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";

  switch (format) {
    case "weeks":
      return fmtDecimalPlaytime(seconds, 7 * 24 * 60 * 60, "week", "weeks");
    case "days":
      return fmtDecimalPlaytime(seconds, 24 * 60 * 60, "day", "days");
    case "hours":
      return fmtDecimalPlaytime(seconds, 60 * 60, "hour", "hours");
    case "hoursMinutes": {
      const totalMinutes = Math.round(seconds / 60);
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${INTEGER_PLAYTIME.format(hours)}h ${minutes}m`;
    }
    case "minutesSeconds": {
      const totalSeconds = Math.round(seconds);
      const minutes = Math.floor(totalSeconds / 60);
      const remainderSeconds = totalSeconds % 60;
      return `${INTEGER_PLAYTIME.format(minutes)}m ${remainderSeconds}s`;
    }
    default:
      return "—";
  }
}

function fmtDecimalPlaytime(
  seconds: number,
  unitSeconds: number,
  singular: string,
  plural: string,
): string {
  const value = seconds / unitSeconds;
  if (value === 0) return `0 ${plural}`;
  if (value < 0.01) return `<0.01 ${plural}`;

  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return `${DECIMAL_PLAYTIME.format(rounded)} ${rounded === 1 ? singular : plural}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
