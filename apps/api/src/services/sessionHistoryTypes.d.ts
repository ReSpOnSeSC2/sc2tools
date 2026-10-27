import type { GlobalFilters } from "../util/parseQuery";
import type { historySummaryCandidates } from "./sessionHistorySummary";

export type HistoryCandidate = ReturnType<typeof historySummaryCandidates>[number];
export type HistoryMember = HistoryCandidate["members"][number];
export type HistoryMmrTrack = HistoryCandidate["summary"]["mmr"][number];
/** Recorded rating interpretation; comparable also requires a supported queued race. */
export type HistoryRatingScope = HistoryMmrTrack["ratingScope"];
export type HistoryMode = "natural" | "current";
export type HistoryStatus = "ready" | "context_required" | "narrow_window";
export interface HistoryCoverage { left: "gap" | "scope"; right: "gap" | "scope" | "as_of"; }
export type HistorySummary = Omit<HistoryCandidate["summary"], "mmr"> & {
  id: string; active: boolean; coverage: HistoryCoverage;
  mmr: Omit<HistoryMmrTrack, "steps">[];
};
export interface HistoryGame extends HistoryMember {
  id: string | null; map: string | null; myRace: string | null;
  opponent: { displayName: string | null; race: string | null; toonHandle: string | null; mmr: number | null };
  gameVersion: string | null; gameBuild: number | null;
  matchFormat: string | null; playerCount: number | null; isLadderGame: boolean | null;
  buildPlanned: boolean; detectedBuild: string | null;
  replayAvailable: boolean; replaySizeBytes: number | null;
}
export interface HistoryWindow {
  from: string; to: string; asOf: string; scanFrom: string; scanTo: string; contextDays: number; tz: string;
}
export interface HistoryDefinition { mode: HistoryMode; gapMinutes: number; scopeHash: string; }
export interface HistoryIssue { code: string; message: string; suggestedContextDays: number | null; }
export interface HistoryBase {
  status: HistoryStatus; definition: HistoryDefinition; window: HistoryWindow; issue: HistoryIssue | null;
}
export interface HistoryList extends HistoryBase {
  kind: "history"; items: HistorySummary[]; nextBefore: string | null;
  nextWindow: { from: string; to: string } | null;
}
export interface HistoryCurrent extends HistoryBase {
  kind: "current"; session: HistorySummary | null; activity: "active" | "last" | "empty";
  manualAnchorAt: string | null;
}
export interface HistoryDetail extends HistoryBase {
  kind: "detail"; session: HistorySummary | null; games: HistoryGame[];
  gamePage: { limit: number; count: number; total: number };
  nextGamesBefore: string | null; mmr: HistoryMmrTrack[];
}
export interface HistorySpan {
  from: number; to: number; asOf: number; scanFrom: number; scanTo: number; contextDays: number; tz: string;
}
export interface HistoryContext {
  mode: HistoryMode; gapMinutes: number; scopeHash: string; filters: GlobalFilters;
  span: HistorySpan; floor: number | null; ceiling: number; anchor: string | null;
}
export interface SessionDescriptor {
  v: 1; k: HistoryMode; s: string; g: number; a: string | null; f: string; e: string; h: string;
}
export interface PageDescriptor {
  v: 1; k: "before"; s: string; g: number; f: string; t: string; n: string; c: number; z: string; h: string; b: string;
}
export interface GamePageDescriptor { v: 1; k: "games"; s: string; p: number; }
export interface CompleteCandidate {
  candidate: HistoryCandidate; games: HistoryGame[]; descriptor: SessionDescriptor;
  coverage: HistoryCoverage | null; start: number; end: number;
}
export interface HistoryLoad {
  context: HistoryContext; status: HistoryStatus; issue: HistoryIssue | null;
  candidates: CompleteCandidate[]; digest: string;
}
