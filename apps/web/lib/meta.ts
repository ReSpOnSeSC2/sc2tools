// Shared types + helpers for the public Ladder Meta Radar page. Kept
// framework-agnostic (no "use client") so the server page and the client
// report/controls components can all import it without duplication.
//
// The shapes mirror the API's GET /v1/meta/ladder response
// (apps/api/src/services/ladderMeta.js -> shapeServedRow).

/** One opener bucket within a (league band, matchup) row. Winrate and
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

/** One served (league band, matchup) row. */
export interface MetaRow {
  leagueBand: number;
  league: string;
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
const DEFAULT_MATCHUP = "PvZ";

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

/** Coerce a raw query param into a valid matchup, defaulting to PvZ. */
export function parseMatchup(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_MATCHUP;
  const up = raw.trim().toUpperCase();
  return isValidMatchup(up) ? up : DEFAULT_MATCHUP;
}

/** Strip the redundant "<X>v<Y> - " matchup prefix the agent bakes into
 *  ``myBuild`` so the report shows just the opener ("Gateway Expand"). */
export function formatOpenerLabel(build: string): string {
  return build.replace(/^[PTZ]v[PTZ]\s*-\s*/i, "").trim() || build;
}
