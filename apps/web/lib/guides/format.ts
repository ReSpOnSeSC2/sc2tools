/**
 * Guide formatting + query parsing helpers. Pure and deterministic
 * (fixed en-US number formatting, UTC dates) so server-rendered guide
 * pages produce identical HTML on every machine.
 *
 * Reuses `lib/format` (percentages) and `lib/meta` (league / MMR band
 * tables, era parsing) instead of redefining them, so the guide band
 * labels always match the Ladder Pulse ones.
 */
import { pct, pct1 } from "@/lib/format";
import { LEAGUES, MMR_BANDS, parsePatchEra } from "@/lib/meta";
import type { GuideBandType, GuideCi, GuideEra } from "@/lib/guides/types";

export { pct as fmtPctWhole, pct1 as fmtPct };

/** Rendered for a missing / non-finite value (same glyph as lib/format). */
export const GUIDE_MISSING = "—";
/** En dash between the two ends of a range. */
const RANGE_DASH = "–";
/** True minus sign for negative deltas. */
const MINUS_SIGN = "−";
const PERCENT_SCALE = 100;
const PCT_DECIMALS = 1;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PAD_WIDTH = 2;
/** Percentage-point suffix for win-rate / prevalence deltas. */
const PP_SUFFIX = "pp";

/**
 * A week-over-week move smaller than this (a fraction, 0.005 = 0.5
 * percentage points) renders as "flat": nightly noise, not a trend.
 */
export const GUIDE_TREND_FLAT_THRESHOLD = 0.005;

/** Query key and value separator of the matchup-page band filter. */
export const GUIDE_BAND_PARAM = "band";
export const GUIDE_ERA_PARAM = "era";
const BAND_SEPARATOR = ":";
export const GUIDE_DEFAULT_ERA: GuideEra = "after";

const COUNT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** A parsed `band=<type>:<value>` filter. */
export interface GuideBandQuery {
  type: GuideBandType;
  value: number;
}

export type GuideTrendDirection = "up" | "down" | "flat";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percentText(fraction: number): string {
  return (fraction * PERCENT_SCALE).toFixed(PCT_DECIMALS);
}

/**
 * Confidence-interval range text with one decimal.
 *
 * Example: `fmtCi({ low: 0.5142, high: 0.5701 })` → "51.4–57.0%".
 */
export function fmtCi(ci: GuideCi | null | undefined): string {
  if (!ci || !isFiniteNumber(ci.low) || !isFiniteNumber(ci.high)) {
    return GUIDE_MISSING;
  }
  return `${percentText(ci.low)}${RANGE_DASH}${percentText(ci.high)}%`;
}

/**
 * Whole count with en-US thousands separators (deterministic).
 *
 * Example: `fmtCount(12345)` → "12,345".
 */
export function fmtCount(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return GUIDE_MISSING;
  return COUNT_FORMAT.format(value);
}

/**
 * Recorded build-log seconds as a game clock. Rounds to whole seconds
 * BEFORE splitting, so 59.6 s renders "1:00" (never "0:60").
 *
 * Example: `fmtClock(271)` → "4:31".
 */
export function fmtClock(seconds: number | null | undefined): string {
  if (!isFiniteNumber(seconds) || seconds < 0) return GUIDE_MISSING;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / SECONDS_PER_MINUTE);
  const rest = String(total % SECONDS_PER_MINUTE).padStart(SECONDS_PAD_WIDTH, "0");
  return `${minutes}:${rest}`;
}

/**
 * Direction of a fractional delta, with moves under
 * {@link GUIDE_TREND_FLAT_THRESHOLD} treated as flat.
 *
 * Example: `trendDirection(0.012)` → "up"; `trendDirection(-0.003)` → "flat".
 */
export function trendDirection(
  delta: number | null | undefined,
  threshold: number = GUIDE_TREND_FLAT_THRESHOLD,
): GuideTrendDirection {
  if (!isFiniteNumber(delta) || Math.abs(delta) < threshold) return "flat";
  return delta > 0 ? "up" : "down";
}

/**
 * Signed percentage-point delta.
 *
 * Example: `fmtDeltaPp(0.0123)` → "+1.2 pp"; `fmtDeltaPp(-0.008)` → "−0.8 pp".
 */
export function fmtDeltaPp(delta: number | null | undefined): string {
  if (!isFiniteNumber(delta)) return GUIDE_MISSING;
  const text = percentText(Math.abs(delta));
  if (Number(text) === 0) return `0.0 ${PP_SUFFIX}`;
  const sign = delta > 0 ? "+" : MINUS_SIGN;
  return `${sign}${text} ${PP_SUFFIX}`;
}

/**
 * Deterministic UTC calendar date for "Updated …" lines.
 *
 * Example: `fmtGuideDate("2026-09-27T03:10:00.000Z")` → "Sep 27, 2026".
 */
export function fmtGuideDate(iso: string | null | undefined): string {
  if (!iso) return GUIDE_MISSING;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return GUIDE_MISSING;
  return DATE_FORMAT.format(date);
}

/** First value of a Next.js search param (string | string[] | undefined). */
function firstParam(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[0] : raw;
}

function isLeagueBand(value: number): boolean {
  return LEAGUES.some((league) => league.id === value);
}

function isMmrBand(value: number): boolean {
  return MMR_BANDS.some((band) => band.key === value);
}

/**
 * Parse a `band` query value. Unknown axes / values → null (the API
 * likewise ignores them and serves all bands).
 *
 * Example: `parseGuideBand("league:4")` → `{ type: "league", value: 4 }`;
 * `parseGuideBand("mmr:4500")` → `{ type: "mmr", value: 4500 }`;
 * `parseGuideBand("mmr:4400")` → null.
 */
export function parseGuideBand(raw: unknown): GuideBandQuery | null {
  const text = firstParam(raw);
  if (typeof text !== "string") return null;
  const match = /^(league|mmr):(\d{1,5})$/.exec(text.trim().toLowerCase());
  if (!match) return null;
  const type: GuideBandType = match[1] === "mmr" ? "mmr" : "league";
  const value = Number(match[2]);
  const isKnown = type === "mmr" ? isMmrBand(value) : isLeagueBand(value);
  return isKnown ? { type, value } : null;
}

/**
 * Serialise a band filter for a query string.
 *
 * Example: `serializeGuideBand({ type: "mmr", value: 4500 })` → "mmr:4500".
 */
export function serializeGuideBand(band: GuideBandQuery): string {
  return `${band.type}${BAND_SEPARATOR}${band.value}`;
}

/**
 * Parse an `era` query value; anything but "before" is the current era.
 *
 * Example: `parseGuideEra("before")` → "before"; `parseGuideEra(["x"])` → "after".
 */
export function parseGuideEra(raw: unknown): GuideEra {
  return parsePatchEra(firstParam(raw));
}

/**
 * Query string for a matchup page / API call. Defaults are omitted so
 * the canonical (unfiltered) URL has no query at all.
 *
 * Example: `guideBandQueryString({ type: "league", value: 4 }, "before")`
 * → "?band=league:4&era=before"; `guideBandQueryString(null, "after")` → "".
 */
export function guideBandQueryString(
  band: GuideBandQuery | null | undefined,
  era: GuideEra = GUIDE_DEFAULT_ERA,
): string {
  const parts: string[] = [];
  if (band) parts.push(`${GUIDE_BAND_PARAM}=${serializeGuideBand(band)}`);
  if (era !== GUIDE_DEFAULT_ERA) parts.push(`${GUIDE_ERA_PARAM}=${era}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/**
 * League name for a league band id, or null for an unknown id.
 *
 * Example: `guideLeagueLabel(4)` → "Diamond".
 */
export function guideLeagueLabel(value: number): string | null {
  return LEAGUES.find((league) => league.id === value)?.label ?? null;
}

/**
 * MMR band label ("4500–5000 MMR"), or null for an unknown band key.
 *
 * Example: `guideMmrLabel(1000)` → "<2000 MMR".
 */
export function guideMmrLabel(value: number): string | null {
  const band = MMR_BANDS.find((candidate) => candidate.key === value);
  return band ? `${band.label} MMR` : null;
}

/**
 * Label for a parsed band on either axis.
 *
 * Example: `guideBandLabel({ type: "league", value: 6 })` → "Grandmaster".
 */
export function guideBandLabel(band: GuideBandQuery): string | null {
  return band.type === "mmr" ? guideMmrLabel(band.value) : guideLeagueLabel(band.value);
}
