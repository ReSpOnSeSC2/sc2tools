export function historyFixtureData(owner, { older = false, current = false, tz = "UTC", long = false, raw = false } = {}) {
  if (long && !current) return longFixtureData(owner, older, tz);
  if (raw) return rawFixtureData(owner, { older, current, tz });
  return standardFixtureData(owner, older, current, tz);
}

function standardFixtureData(owner, older, current, tz) {
  const date = older ? "2026-10-26" : "2026-10-27", value = (owner === "synthetic-a" ? 3000 : 4000) - (older ? 100 : 0);
  const start = `${date}T03:40:00.000Z`, end = `${date}T04:15:00.000Z`, toon = owner === "synthetic-a" ? "1-S2-1-101" : "2-S2-1-202";
  const track = { myToonHandle: toon, ladderRace: "P", ratingScope: "ranked-1v1", comparable: true, games: 3, samples: 2, missingGames: 1, legacySamples: 0, start: value, end: value + 20, delta: 20, peak: value + 20 };
  const record = { games: 3, wins: 1, losses: 1, unknown: 1 };
  const session = fixtureSession(owner, older, current, start, end, record, track);
  const base = fixtureBase(owner, current, tz);
  const dates = [start, `${date}T03:55:00.000Z`, end], gaps = [null, 900, 1200], durations = [840, 900, null], ratings = [value, null, value + 20];
  const names = ["Two gate blink", "Two gate blink", null], provenance = ["planned", "detected", "unavailable"], detected = ["Detected blink", "Two gate blink", null], sources = ["replay", null, "replay"];
  const games = ["W", "L", "U"].map((outcome, index) => ({ position: index + 1, gameId: null, id: null, date: dates[index], outcome, myToonHandle: toon, ladderRace: "P", matchup: "PvT", ratingScope: "ranked-1v1", comparable: true,
    recordedEndGapSec: gaps[index], durationSec: durations[index], macroScore: [0, null, null][index], myMmr: ratings[index], myMmrSource: sources[index],
    build: { name: names[index], provenance: provenance[index], detectedName: detected[index] }, map: "Synthetic map", myRace: "P", opponent: { displayName: "Synthetic opponent", race: "T", toonHandle: "1-S2-1-999", mmr: 3000 },
    gameVersion: "5.0.17", gameBuild: 100001, matchFormat: "1v1", playerCount: 2, isLadderGame: true, buildPlanned: index === 0, detectedBuild: detected[index], replayAvailable: false, replaySizeBytes: null }));
  return { base, session, games, mmr: [{ ...track, steps: games.map(game => ({ position: game.position, gameId: game.gameId, date: game.date, value: game.myMmr, source: game.myMmrSource })) }] };
}

function fixtureSession(owner, older, current, start, end, record, track) {
  return { id: `${current ? "current" : "natural"}-${owner}${older ? "-older" : ""}`, start, end, ...record, results: "WLU", playedMin: 29, durationSamples: 2, durationMissingGames: 1,
    avgMacro: 0, macroSamples: 1, macroMissingGames: 2, matchups: [{ matchup: "PvT", ...record }], topBuilds: [{ name: "Two gate blink", games: 2, wins: 1, losses: 1, unknown: 0, plannedGames: 1, detectedGames: 1, provenanceUnavailableGames: 0 }],
    topBuildsOtherGames: 0, buildMissingGames: 1, longestDecidedStreak: { wins: 1, losses: 1 }, afterLoss: { wins: 0, losses: 0, decidedGames: 0, winRate: null, lossWithoutFollowingDecision: 1 }, mmr: [track], mmrUnattributedGames: 0, mmrUnattributedSamples: 0, active: false, coverage: { left: current ? "scope" : "gap", right: "gap" } };
}

function fixtureBase(owner, current, tz) {
  return { status: "ready", definition: { mode: current ? "current" : "natural", gapMinutes: 90, scopeHash: `synthetic-${owner}` }, issue: null,
    window: { from: current ? "2026-10-27T03:30:00.000Z" : "2026-10-01T00:00:00.000Z", to: current ? "2026-10-27T06:00:00.001Z" : "2026-10-28T00:00:00.000Z", asOf: "2026-10-27T06:00:00.000Z", scanFrom: current ? "2026-10-27T03:30:00.000Z" : "2026-09-30T22:30:00.000Z", scanTo: "2026-10-27T06:00:00.000Z", contextDays: 0, tz } };
}

function longFixtureData(owner, older, tz) {
  const seed = historyFixtureData(owner, { older, tz }), base = seed.mmr[0].start;
  const start = Date.parse(older ? "2026-10-26T00:00:00.000Z" : "2026-10-27T00:00:00.000Z");
  const games = Array.from({ length: 125 }, (_, index) => {
    const value = (index + 1) % 10 === 0 ? null : base + index;
    return { ...seed.games[index % 3], position: index + 1, date: new Date(start + index * 60_000).toISOString(), recordedEndGapSec: index === 0 ? null : 60, durationSec: 60, macroScore: 0, myMmr: value, myMmrSource: value === null ? null : "replay" };
  });
  const track = { ...seed.mmr[0], games: 125, samples: 113, missingGames: 12, start: base, end: base + 124, delta: 124, peak: base + 124,
    steps: games.map(game => ({ position: game.position, gameId: null, date: game.date, value: game.myMmr, source: game.myMmrSource })) };
  const session = { ...seed.session, id: `${seed.session.id}-long`, start: games[0].date, end: games.at(-1).date, games: 125, wins: 42, losses: 42, unknown: 41, results: games.map(game => game.outcome).join(""), playedMin: 125,
    durationSamples: 125, durationMissingGames: 0, macroSamples: 125, macroMissingGames: 0, matchups: [{ matchup: "PvT", games: 125, wins: 42, losses: 42, unknown: 41 }],
    topBuilds: [{ name: "Two gate blink", games: 84, wins: 42, losses: 42, unknown: 0, plannedGames: 42, detectedGames: 42, provenanceUnavailableGames: 0 }], buildMissingGames: 41,
    afterLoss: { wins: 41, losses: 0, decidedGames: 41, winRate: 1, lossWithoutFollowingDecision: 1 }, mmr: [{ ...track, steps: undefined }] };
  delete session.mmr[0].steps;
  return { base: seed.base, session, games, mmr: [track] };
}

function rawFixtureData(owner, options) {
  const value = historyFixtureData(owner, options);
  const track = value.mmr[0];
  value.games = value.games.map(game => ({ ...game, ladderRace: null, comparable: false }));
  value.mmr = [{ ...track, ladderRace: null, comparable: false, delta: null }];
  const summary = { ...value.mmr[0] }; delete summary.steps;
  value.session.mmr = [summary];
  return value;
}
export function applyCurrentIngest(value) {
  const last = value.games.at(-1), rating = value.mmr[0].start + 30, date = "2026-10-27T05:30:00.000Z";
  value.games.push({ ...last, position: 4, date, outcome: "W", recordedEndGapSec: 4500, durationSec: 600, macroScore: 10, myMmr: rating, myMmrSource: "replay",
    build: { name: "Two gate blink", provenance: "detected", detectedName: "Two gate blink" }, detectedBuild: "Two gate blink", buildPlanned: false });
  const track = { ...value.mmr[0], games: 4, samples: 3, end: rating, delta: 30, peak: rating,
    steps: [...value.mmr[0].steps, { position: 4, gameId: null, date, value: rating, source: "replay" }] };
  const summary = { ...track }; delete summary.steps;
  value.mmr = [track];
  value.session = { ...value.session, id: `${value.session.id}-after-ingest`, end: date, games: 4, wins: 2, results: "WLUW", playedMin: 39, durationSamples: 3,
    avgMacro: 5, macroSamples: 2, matchups: [{ matchup: "PvT", games: 4, wins: 2, losses: 1, unknown: 1 }],
    topBuilds: [{ name: "Two gate blink", games: 3, wins: 2, losses: 1, unknown: 0, plannedGames: 1, detectedGames: 2, provenanceUnavailableGames: 0 }],
    afterLoss: { wins: 1, losses: 0, decidedGames: 1, winRate: 1, lossWithoutFollowingDecision: 0 }, mmr: [summary], active: true, coverage: { left: "scope", right: "as_of" } };
  return value;
}