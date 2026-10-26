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
  /** API race labels ("vs P", etc.), displayed as "vs Protoss" / "vs Unknown race". */
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
  /** Replay Review Exchange section; absent until they have reviewed. */
  reviewer?: PublicReviewerSection | null;
  publishedBuilds?: PublicProfileFeaturedBuild[];
  sections?: Record<"showReplays" | "showChannels" | "showRecentForm" | "showMmrHistory" | "showSeasons" | "showMaps", boolean>;
  replayArchive?: { handle: string; total: number } | null;
  recentForm?: Array<{ result: "W" | "L" | "T"; matchup: string; date: string }>;
  currentStreak?: { kind: "W" | "L"; count: number } | null;
  lastPlayedAt?: string | null;
  channels?: Array<{ platform: "twitch" | "youtube"; url: string }>;
  mmrHistory?: Array<{ date: string; mmr: number; games: number }>;
  seasons?: Array<{ season: number; games: number; wins: number; losses: number; peakMmr: number | null; mainRace: string | null }>;
  seasonDataAvailable?: boolean;
  maps?: Array<{ name: string; games: number; wins: number; losses: number }>;
}

export interface PublicPlayerResponse {
  profile: PublicPlayerProfile | null;
  archiveOnly: boolean;
  handle: string;
  displayName: string;
}

export interface PublicPlayerSettings {
  /** Private preview of the name that an explicit opt-in will publish. */
  publicDisplayName?: string;
  enabled: boolean;
  legacyPublic: boolean;
  slug: string | null;
  updatedAt: string | null;
  renameAvailableAt: string | null;
  replaySharingEnabled: boolean;
  revision: number;
  showReplays: boolean;
  showChannels: boolean;
  showRecentForm: boolean;
  showMmrHistory: boolean;
  showSeasons: boolean;
  showMaps: boolean;
}

export interface PublicReviewerSection {
  karma: number;
  reviews: number;
  helpful: number;
  bestAnswers: number;
  badges: Array<{ key: string; label: string }>;
  flair: string | null;
  verified: {
    band: { id: number; label: string };
    race: string | null;
    mmr: number | null;
    /** The league in each region they play ranked 1v1 in, strongest first. */
    regions?: Array<{ region: string; band: { id: number; label: string }; race: string | null }>;
  } | null;
  matchupsReviewed: Array<{ matchup: string; count: number }>;
  matchupsSampled?: true;
  matchupsSampleLimit?: number;
}

/** Envelope returned by GET /v1/public/profile/:handle. */
export interface PublicProfileResponse {
  profile: PublicPlayerProfile;
}
