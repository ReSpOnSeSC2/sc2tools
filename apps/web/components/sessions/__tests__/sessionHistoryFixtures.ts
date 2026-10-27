import type { SessionHistoryBase, SessionHistoryCurrent, SessionHistoryDetail, SessionHistoryGame, SessionHistoryList } from "@/lib/sessionHistory";
import { sessionSummary } from "./sessionCardFixtures";

export const HISTORY_BASE: SessionHistoryBase = {
  status: "ready", definition: { mode: "natural", gapMinutes: 90, scopeHash: "opaque-scope" }, issue: null,
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-28T00:00:00.000Z", asOf: "2026-10-27T05:00:00.000Z", scanFrom: "2026-09-30T22:30:00.000Z", scanTo: "2026-10-27T05:00:00.000Z", contextDays: 0, tz: "UTC" },
};
export function historyList(overrides: Partial<SessionHistoryList> = {}): SessionHistoryList {
  return { ...HISTORY_BASE, kind: "history", items: [sessionSummary()], nextBefore: "older-page", nextWindow: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" }, ...overrides };
}
export function currentHistory(overrides: Partial<SessionHistoryCurrent> = {}): SessionHistoryCurrent {
  const anchor = overrides.manualAnchorAt === undefined ? "2026-10-27T03:30:00.000Z" : overrides.manualAnchorAt;
  const asOf = overrides.activity === "last" ? "2026-10-27T06:00:00.000Z" : "2026-10-27T05:00:00.000Z";
  const from = anchor ?? "2026-10-13T05:00:00.000Z";
  return { ...HISTORY_BASE, definition: { ...HISTORY_BASE.definition, mode: "current" }, kind: "current", session: sessionSummary({ coverage: { left: "scope", right: "as_of" } }), activity: "active", manualAnchorAt: anchor,
    window: { ...HISTORY_BASE.window, from, to: new Date(Date.parse(asOf) + 1).toISOString(), asOf, scanFrom: from, scanTo: asOf }, ...overrides };
}
export function historyGame(overrides: Partial<SessionHistoryGame> = {}): SessionHistoryGame {
  return { id: null, gameId: null, position: 1, date: "2026-10-27T03:40:00.000Z", outcome: "W", myToonHandle: "1-S2-1-101", ladderRace: "P", matchup: "PvT", ratingScope: "ranked-1v1", comparable: true,
    recordedEndGapSec: null, durationSec: 840, macroScore: 0, myMmr: 3000, myMmrSource: "legacy", build: { name: "Two gate blink", provenance: "planned", detectedName: "Detected blink" },
    map: "Map", myRace: "P", opponent: { displayName: "Opponent", race: "T", toonHandle: "1-S2-1-999", mmr: 3000 }, gameVersion: "5.0.17", gameBuild: 100001,
    matchFormat: "1v1", playerCount: 2, isLadderGame: true, buildPlanned: true, detectedBuild: "Detected blink", replayAvailable: false, replaySizeBytes: null, ...overrides };
}
export function historyDetail(overrides: Partial<SessionHistoryDetail> = {}): SessionHistoryDetail {
  return { ...HISTORY_BASE, kind: "detail", session: sessionSummary(), games: [historyGame()],
    gamePage: { limit: 50, count: 1, total: 3 }, nextGamesBefore: "next-game-page", mmr: [], ...overrides };
}
