import type { SessionBuild, SessionMatchup, SessionMmrTrack, SessionSummary } from "@/lib/sessionHistory";

export function mmrTrack(overrides: Partial<SessionMmrTrack> = {}): SessionMmrTrack {
  return {
    myToonHandle: "1-S2-1-101", ladderRace: "P", ratingScope: "ranked-1v1", comparable: true, games: 2, samples: 2,
    missingGames: 0, legacySamples: 1, start: 3000, end: 3020, delta: 20, peak: 3020,
    ...overrides,
  };
}

export function matchup(overrides: Partial<SessionMatchup> = {}): SessionMatchup {
  return { matchup: "PvT", games: 3, wins: 1, losses: 1, unknown: 1, ...overrides };
}

export function build(overrides: Partial<SessionBuild> = {}): SessionBuild {
  return {
    name: "Two gate blink", games: 2, wins: 1, losses: 1, unknown: 0,
    plannedGames: 1, detectedGames: 1, provenanceUnavailableGames: 0, ...overrides,
  };
}

export function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "opaque-session-descriptor", start: "2026-10-27T03:40:00.000Z", end: "2026-10-27T04:15:00.000Z",
    games: 3, wins: 1, losses: 1, unknown: 1, results: "WLU",
    playedMin: 29, durationSamples: 2, durationMissingGames: 1,
    avgMacro: 0, macroSamples: 1, macroMissingGames: 2,
    matchups: [matchup()], topBuilds: [build()], topBuildsOtherGames: 0, buildMissingGames: 1,
    longestDecidedStreak: { wins: 1, losses: 1 },
    afterLoss: { wins: 0, losses: 0, decidedGames: 0, winRate: null, lossWithoutFollowingDecision: 1 },
    mmr: [mmrTrack(), mmrTrack({ ladderRace: "R", games: 1, samples: 1, legacySamples: 0, start: 3100, end: 3100, delta: null, peak: 3100 })],
    mmrUnattributedGames: 0, mmrUnattributedSamples: 0,
    active: true, coverage: { left: "gap", right: "as_of" }, ...overrides,
  };
}
