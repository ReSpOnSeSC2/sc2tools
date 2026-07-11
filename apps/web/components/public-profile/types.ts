/**
 * Public-API shapes for the opt-in player page at /p/[handle].
 *
 * Mirrors the payload built by apps/api/src/services/publicProfile.js.
 * Kept deliberately narrow: only non-sensitive aggregates cross this
 * boundary — no opponent identities, no per-game rows. If the server
 * ever grows a field, it stays invisible here until it's added on
 * purpose.
 */

export interface PublicProfileTotals {
  games: number;
  wins: number;
  losses: number;
  /** Fraction in [0, 1] over decided games. */
  winRate: number;
}

export interface PublicProfileMatchupSplit {
  /** "vs P" / "vs T" / "vs Z" / "vs Unknown" — race letters, not people. */
  matchup: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface PublicProfileSignatureBuild {
  /** The player's own build label, e.g. "PvT - Glaive Adept Timing". */
  name: string;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface PublicProfileFeaturedBuild {
  slug: string;
  title: string;
  matchup: string | null;
  votes: number;
}

export interface PublicPlayerProfile {
  handle: string;
  displayName: string;
  /** Full race name ("Protoss" | "Terran" | "Zerg" | "Random") or null. */
  mainRace: string | null;
  joinedAt: string | null;
  totals: PublicProfileTotals;
  matchups: PublicProfileMatchupSplit[];
  signatureBuilds: PublicProfileSignatureBuild[];
  featuredBuild: PublicProfileFeaturedBuild | null;
  publishedBuildCount: number;
}

/** Envelope returned by GET /v1/public/profile/:handle. */
export interface PublicProfileResponse {
  profile: PublicPlayerProfile;
}
