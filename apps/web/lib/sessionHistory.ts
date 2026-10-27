/** Public leaf DTO only. The parent owns admission, URLs, window and scope. */
export type SessionRace = "P" | "T" | "Z" | "R" | null;
export type SessionOutcome = "W" | "L" | "U";
export type SessionRatingScope = `${"ranked" | "custom" | "unknown"}-${"1v1" | "team" | "ffa" | "other" | "unknown"}`;

export interface SessionRecord {
  games: number;
  wins: number;
  losses: number;
  unknown: number;
}

export interface SessionMatchup extends SessionRecord {
  matchup: string;
}

export interface SessionBuild extends SessionRecord {
  name: string;
  plannedGames: number;
  detectedGames: number;
  provenanceUnavailableGames: number;
}

/** List summaries deliberately omit the detail-only steps array. */
export interface SessionMmrTrack {
  ratingScope: SessionRatingScope;
  comparable: boolean;
  myToonHandle: string;
  ladderRace: SessionRace;
  games: number;
  samples: number;
  missingGames: number;
  legacySamples: number;
  start: number | null;
  end: number | null;
  delta: number | null;
  peak: number | null;
}

export interface SessionSummary extends SessionRecord {
  /** Opaque parent-owned locator; the leaf never decodes or builds a URL. */
  id: string;
  /** First and last recorded replay-END instants, not inferred play starts. */
  start: string;
  end: string;
  results: string;
  playedMin: number | null;
  durationSamples: number;
  durationMissingGames: number;
  avgMacro: number | null;
  macroSamples: number;
  macroMissingGames: number;
  matchups: readonly SessionMatchup[];
  topBuilds: readonly SessionBuild[];
  topBuildsOtherGames: number;
  buildMissingGames: number;
  longestDecidedStreak: { wins: number; losses: number };
  afterLoss: {
    wins: number;
    losses: number;
    decidedGames: number;
    winRate: number | null;
    lossWithoutFollowingDecision: 0 | 1;
  };
  mmr: readonly SessionMmrTrack[];
  mmrUnattributedGames: number;
  mmrUnattributedSamples: number;
  active: boolean;
  coverage: {
    left: "gap" | "scope";
    right: "gap" | "scope" | "as_of";
  };
}

export interface SessionMmrStep {
  position: number; gameId: string | null; date: string; value: number | null;
  source: "replay" | "legacy" | null;
}
export interface SessionDetailTrack extends SessionMmrTrack { steps: SessionMmrStep[]; }
export interface SessionHistoryWindow {
  from: string; to: string; asOf: string; scanFrom: string; scanTo: string; contextDays: number; tz: string;
}
export interface SessionHistoryBase {
  status: "ready" | "context_required" | "narrow_window";
  definition: { mode: "natural" | "current"; gapMinutes: number; scopeHash: string };
  window: SessionHistoryWindow;
  issue: { code: string; message: string; suggestedContextDays: number | null } | null;
}
export interface SessionHistoryList extends SessionHistoryBase {
  kind: "history"; items: SessionSummary[]; nextBefore: string | null;
  nextWindow: { from: string; to: string } | null;
}
export interface SessionHistoryCurrent extends SessionHistoryBase {
  kind: "current"; session: SessionSummary | null; activity: "active" | "last" | "empty";
  manualAnchorAt: string | null;
}
export interface SessionHistoryGame {
  position: number; gameId: string | null; id: string | null; date: string; outcome: SessionOutcome;
  myToonHandle: string | null; ladderRace: string | null; matchup: string;
  ratingScope: SessionRatingScope; comparable: boolean;
  recordedEndGapSec: number | null; durationSec: number | null; macroScore: number | null;
  myMmr: number | null; myMmrSource: "replay" | "legacy" | null;
  build: { name: string | null; provenance: "planned" | "detected" | "unavailable"; detectedName: string | null };
  map: string | null; myRace: string | null;
  opponent: { displayName: string | null; race: string | null; toonHandle: string | null; mmr: number | null };
  gameVersion: string | null; gameBuild: number | null; matchFormat: string | null;
  playerCount: number | null; isLadderGame: boolean | null; buildPlanned: boolean; detectedBuild: string | null;
  replayAvailable: boolean; replaySizeBytes: number | null;
}
export interface SessionHistoryDetail extends SessionHistoryBase {
  kind: "detail"; session: SessionSummary | null; games: SessionHistoryGame[];
  gamePage: { limit: number; count: number; total: number }; nextGamesBefore: string | null;
  mmr: SessionDetailTrack[];
}
