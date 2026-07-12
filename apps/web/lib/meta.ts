// Shared types + helpers for the public Ladder Meta Radar page. Kept
// framework-agnostic (no "use client") so the server page and the client
// report/controls components can all import it without duplication.
//
// The shapes mirror the API's GET /v1/meta/ladder response
// (apps/api/src/services/ladderMeta.js -> shapeServedRow).

/** One opener bucket within an (opponent band, matchup) row. Winrate and
 *  frequency are fractions in 0..1; the deltas are the change since the
 *  previous nightly run (null when the opener is newly surfaced). */
export interface MetaOpener {
  build: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  frequency: number;
  winRateDelta: number | null;
  freqDelta: number | null;
  isNew: boolean;
}

export type BandAxis = "league" | "mmr";

/** One served (opponent band, matchup) row. League fields remain optional
 *  because they only exist on league rows for API backwards compatibility. */
export interface MetaRow {
  bandType: BandAxis;
  band: number;
  bandLabel: string;
  leagueBand?: number;
  league?: string;
  matchup: string;
  n: number;
  openers: MetaOpener[];
  updatedAt: string;
  prevUpdatedAt: string | null;
}

export interface MetaLeague {
  id: number;
  label: string;
}

export interface MetaMmrBand {
  key: number;
  label: string;
}

/** SC2 league enum -> label. Ids match ``opponent.leagueId`` on games
 *  rows and the API's LEAGUE_NAMES banding. */
export const LEAGUES: readonly MetaLeague[] = [
  { id: 0, label: "Bronze" },
  { id: 1, label: "Silver" },
  { id: 2, label: "Gold" },
  { id: 3, label: "Platinum" },
  { id: 4, label: "Diamond" },
  { id: 5, label: "Master" },
  { id: 6, label: "Grandmaster" },
];

/** Opponent-MMR bands used by Ladder Meta Radar. The 1000 key is the
 *  documented sentinel for the open-ended <2000 band; 6500 is the key for
 *  6500+. Interior labels describe half-open 500-MMR ranges. */
export const MMR_BANDS: readonly MetaMmrBand[] = [
  { key: 1000, label: "<2000" },
  { key: 2000, label: "2000–2500" },
  { key: 2500, label: "2500–3000" },
  { key: 3000, label: "3000–3500" },
  { key: 3500, label: "3500–4000" },
  { key: 4000, label: "4000–4500" },
  { key: 4500, label: "4500–5000" },
  { key: 5000, label: "5000–5500" },
  { key: 5500, label: "5500–6000" },
  { key: 6000, label: "6000–6500" },
  { key: 6500, label: "6500+" },
];

/** All nine 1v1 matchups, "<my>v<opp>". */
export const MATCHUPS: readonly string[] = [
  "PvP",
  "PvT",
  "PvZ",
  "TvP",
  "TvT",
  "TvZ",
  "ZvP",
  "ZvT",
  "ZvZ",
];

const DEFAULT_LEAGUE_ID = 4; // Diamond — the densest ladder band
const DEFAULT_MMR_BAND = 4000;
const DEFAULT_MATCHUP = "PvZ";

/** Coerce a raw query param into a supported banding axis. */
export function parseAxis(raw: unknown): BandAxis {
  if (typeof raw !== "string") return "league";
  return raw.trim().toLowerCase() === "mmr" ? "mmr" : "league";
}

/** True for a canonical "<P|T|Z>v<P|T|Z>" matchup string. */
export function isValidMatchup(raw: unknown): raw is string {
  return typeof raw === "string" && /^[PTZ]v[PTZ]$/.test(raw);
}

/** Label for a league id, falling back to "League N" for out-of-enum ids. */
export function leagueLabel(id: number): string {
  return LEAGUES.find((l) => l.id === id)?.label ?? `League ${id}`;
}

/** Coerce a raw query param into a valid league id, defaulting to Diamond. */
export function parseLeagueId(raw: unknown): number {
  const n =
    typeof raw === "string" || typeof raw === "number"
      ? Number.parseInt(String(raw), 10)
      : NaN;
  return LEAGUES.some((l) => l.id === n) ? n : DEFAULT_LEAGUE_ID;
}

/** Coerce a raw band key for the selected axis, using an axis-specific
 *  default when the key is missing or not one of the published bands. */
export function parseBand(axis: BandAxis, raw: unknown): number {
  const n =
    typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (axis === "mmr") {
    return MMR_BANDS.some((candidate) => candidate.key === n)
      ? n
      : DEFAULT_MMR_BAND;
  }
  return LEAGUES.some((candidate) => candidate.id === n)
    ? n
    : DEFAULT_LEAGUE_ID;
}

/** Human-readable label for a band on either axis. */
export function bandLabel(axis: BandAxis, band: number): string {
  if (axis === "mmr") {
    return (
      MMR_BANDS.find((candidate) => candidate.key === band)?.label ??
      MMR_BANDS.find((candidate) => candidate.key === DEFAULT_MMR_BAND)!.label
    );
  }
  return leagueLabel(parseBand("league", band));
}

/** Coerce a raw query param into a valid matchup, defaulting to PvZ.
 *
 *  Canonicalizes to the "<X>v<Y>" form MATCHUPS + isValidMatchup use:
 *  upper-case race letters joined by a lower-case "v". A naive
 *  ``toUpperCase()`` would fold the join into "V" ("PvT" -> "PVT"), which
 *  fails ``isValidMatchup``'s lower-case-"v" pattern — so *every* selection
 *  silently collapsed back to the PvZ default and the matchup picker
 *  appeared frozen. */
export function parseMatchup(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_MATCHUP;
  const m = raw.trim().toUpperCase().match(/^([PTZ])V([PTZ])$/);
  const canonical = m ? `${m[1]}v${m[2]}` : "";
  return isValidMatchup(canonical) ? canonical : DEFAULT_MATCHUP;
}

/** Canonical shareable URL for one axis, opponent band, and matchup. */
export function metaHref(
  axis: BandAxis,
  band: number,
  matchup: string,
): string {
  const canonicalAxis = parseAxis(axis);
  const canonicalBand = parseBand(canonicalAxis, band);
  const canonicalMatchup = parseMatchup(matchup);
  return (
    `/meta?axis=${canonicalAxis}&band=${canonicalBand}` +
    `&matchup=${encodeURIComponent(canonicalMatchup)}`
  );
}

/** Strip the redundant "<X>v<Y> - " matchup prefix the agent bakes into
 *  ``myBuild`` so the report shows just the opener ("Gateway Expand"). */
export function formatOpenerLabel(build: string): string {
  return build.replace(/^[PTZ]v[PTZ]\s*-\s*/i, "").trim() || build;
}
