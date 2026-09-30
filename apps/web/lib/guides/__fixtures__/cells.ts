/**
 * TEST FIXTURES ONLY — helpers that build contract-shaped guide cells.
 * Fixture numbers are hand-picked but internally consistent: `winRate`
 * is wins over decided games and `ci` is the 95% Wilson interval, both
 * rounded to 4 dp exactly like apps/api/src/util/wilson.js, so page
 * tests exercise realistic values. Never import from app code.
 */
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import type { GuideCell } from "@/lib/guides/types";

/** z for a 95% interval (API GUIDE_WILSON_Z). */
const WILSON_Z = 1.96;
const ROUND_SCALE = 10_000;

export const FIXTURE_COMPUTED_AT = "2026-09-27T03:12:44.000Z";
export const FIXTURE_BASELINE_AT = "2026-09-19T03:10:02.000Z";
export const FIXTURE_FIRST_PUBLISHED_AT = "2026-08-02T03:11:37.000Z";
export const FIXTURE_PATCH = "5.0.17";

function round4(value: number): number {
  return Math.round(value * ROUND_SCALE) / ROUND_SCALE;
}

/**
 * Contract cell from raw counts (`ties` count toward games only).
 *
 * Example: `fixtureCell(412, 63, 221, 2)` → winRate 0.539 (221 / 410).
 */
export function fixtureCell(games: number, users: number, wins: number, ties = 0): GuideCell {
  const decided = games - ties;
  const p = wins / decided;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / decided;
  const center = (p + z2 / (2 * decided)) / denom;
  const margin =
    (WILSON_Z * Math.sqrt((p * (1 - p)) / decided + z2 / (4 * decided * decided))) / denom;
  return {
    games,
    users,
    wins,
    winRate: round4(p),
    ci: { low: round4(center - margin), high: round4(center + margin) },
  };
}

/** Verbatim catalog description for a fixture build / strategy name. */
export function fixtureDescription(name: string): string {
  const def = BUILD_DEFINITIONS.find((entry) => entry.name === name);
  if (!def) throw new Error(`fixture name is not in the catalog: ${name}`);
  return def.description;
}

/** Share rounded like the API (4 dp). */
export function fixtureShare(part: number, whole: number): number {
  return round4(part / whole);
}
