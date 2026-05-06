// SC2 ladder season catalog.
//
// Blizzard publishes season boundaries on their support site, but they
// don't expose a stable feed we can pull from the browser. We need a
// lookup that's "good enough" for filtering games by season — within a
// few days of the true boundary is fine, since the user can always
// fall back to the Custom range picker for surgical precision.
//
// Anchor: the user told us they're currently on Season 67 (May 2026),
// and historically each ladder season lasts ~3 months. We anchor that
// fact and approximate other seasons at quarterly boundaries. Older
// seasons before the modern 4-per-year cadence will be more lossy,
// but the typical user only filters within the last few seasons.
//
// We also clamp to "today" as the upper bound for the in-progress
// season, so filtering by Season 67 mid-season doesn't include
// future-dated bogus games.
//
// If/when we wire a real authority for this (e.g. the SC2Pulse API),
// `seasonRange` is the single point to update — every UI consumer
// goes through it.
//
// Re-exported helpers:
//   listSeasons(n)  — descending list of recent N seasons, for picker UIs
//   seasonRange(n)  — { start: Date, end: Date } for the requested season
//   currentSeason() — best-effort guess for the in-progress season

const ANCHOR_SEASON = 67;
// Season 67 is roughly Q2 2026 — start in early April, run ~3 months.
const ANCHOR_START_ISO = "2026-04-01T00:00:00.000Z";
const SEASON_LENGTH_MS = 91 * 24 * 60 * 60 * 1000; // ~3 months

export type SeasonRange = {
  season: number;
  start: Date;
  end: Date;
};

/** Compute the date range for a given season number. End is clamped to today. */
export function seasonRange(season: number): SeasonRange {
  const offsetSeasons = season - ANCHOR_SEASON;
  const anchorStart = new Date(ANCHOR_START_ISO).getTime();
  const start = new Date(anchorStart + offsetSeasons * SEASON_LENGTH_MS);
  const rawEnd = new Date(start.getTime() + SEASON_LENGTH_MS - 1);
  const now = new Date();
  const end = rawEnd > now ? now : rawEnd;
  return { season, start, end };
}

/** Best-effort guess for the season in progress right now. */
export function currentSeason(): number {
  const anchorStart = new Date(ANCHOR_START_ISO).getTime();
  const now = Date.now();
  const offsetMs = now - anchorStart;
  const offsetSeasons = Math.floor(offsetMs / SEASON_LENGTH_MS);
  return ANCHOR_SEASON + offsetSeasons;
}

/** Return the most recent N seasons, newest first. */
export function listSeasons(count: number = 12): number[] {
  const cur = currentSeason();
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
