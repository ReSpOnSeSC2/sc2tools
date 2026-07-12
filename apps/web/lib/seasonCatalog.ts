// SC2 ladder season fallback catalog.
//
// The analyzer's real authority is /v1/seasons, which proxies
// SC2Pulse and supplies exact season numbers/boundaries through
// FiltersContext. These helpers cover only the first render and an
// offline/error state before that catalog is available.
//
// Season lengths are not fixed. In particular, a 91-day projection
// incorrectly invented Season 68 on July 1, 2026 while Battle.net was
// still on Season 67. The fallback therefore stays on the last
// verified current season until a new boundary is explicitly known.
// Historical ranges remain approximate and are only a degraded path.
//
// Re-exported helpers:
//   listSeasons(n)  — descending list of recent N seasons, for picker UIs
//   seasonRange(n)  — { start: Date, end: Date } for the requested season
//   currentSeason() — last verified season for offline/pre-fetch use

// Offline/pre-fetch fallback only. The live authority is the
// SC2Pulse-backed /v1/seasons catalog supplied by FiltersContext.
export const FALLBACK_CURRENT_SEASON = 67;
const ANCHOR_SEASON = FALLBACK_CURRENT_SEASON;
// Approximate anchor used only when the live catalog is unavailable.
const ANCHOR_START_ISO = "2026-04-01T00:00:00.000Z";
const SEASON_LENGTH_MS = 91 * 24 * 60 * 60 * 1000; // ~3 months

export type SeasonRange = {
  season: number;
  start: Date;
  end: Date;
};

/** Compute a fallback range; the last verified season remains open. */
export function seasonRange(
  season: number,
  now: Date = new Date(),
): SeasonRange {
  const offsetSeasons = season - ANCHOR_SEASON;
  const anchorStart = new Date(ANCHOR_START_ISO).getTime();
  const start = new Date(anchorStart + offsetSeasons * SEASON_LENGTH_MS);
  const rawEnd = new Date(start.getTime() + SEASON_LENGTH_MS - 1);
  const end = season === FALLBACK_CURRENT_SEASON || rawEnd > now
    ? new Date(now)
    : rawEnd;
  return { season, start, end };
}

/** Last verified current season for offline/pre-fetch rendering. */
export function currentSeason(_now: Date = new Date()): number {
  return FALLBACK_CURRENT_SEASON;
}

/** Return the most recent N seasons, newest first. */
export function listSeasons(
  count: number = 12,
  now: Date = new Date(),
): number[] {
  const cur = currentSeason(now);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(cur - i);
  return out;
}

/** Format a season range as a short label for picker UIs. */
export function formatSeasonRange(range: SeasonRange): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${fmt(range.start)} – ${fmt(range.end)}`;
}
