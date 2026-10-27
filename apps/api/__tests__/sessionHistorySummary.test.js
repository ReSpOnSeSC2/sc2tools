"use strict";

const fixtures = require("../../../shared/fixtures/sessions.json");
const { withOwnerBuildFlags } = require("../src/services/buildIntentReaders");
const { historySummaryCandidates, canonicalMemberDigest, MAX_SUMMARY_GAMES } = require("../src/services/sessionHistorySummary");

const START = Date.parse("2026-10-26T23:50:00Z");
/** @param {string} gameId @param {number} minutes @param {Record<string,unknown>} [extra] */
function game(gameId, minutes, extra = {}) {
  return { gameId, date: new Date(START + minutes * 60000), myToonHandle: "1-S2-1-100", myRace: "Protoss", myLadderRace: "Protoss",
    matchFormat: "1v1", playerCount: 2, isLadderGame: true, opponent: { race: "Zerg" }, result: "Victory", ...extra };
}

test.each(fixtures)("history delegates shared core membership: $name", fixture => {
  const candidates = historySummaryCandidates(fixture.games, fixture);
  expect(candidates.map(value => value.summary.games)).toEqual(fixture.groups.map(group => group.length));
  expect(candidates.flatMap(value => value.members).every(value => ["W", "L", "U"].includes(value.outcome))).toBe(true);
  for (const candidate of candidates) expect(candidate.summary.results).toHaveLength(candidate.summary.games);
});

test("summarizes complete membership, neutral pips, exact-gap bridges and honest statistical samples", () => {
  const rows = [
    game("a", 0, { result: "Defeat", durationSec: 600, macroScore: 80, myMmr: 5000, myMmrSource: "replay", myBuild: "Alpha", buildPlanned: true, detectedBuild: "Gamma" }),
    game("b", 15, { result: "Tie", durationSec: 0, macroScore: 0, myMmr: null, myBuild: "Alpha", buildPlanned: false }),
    game("c", 30, { durationSec: 1200, macroScore: 100, myMmr: 5025, myBuild: "Alpha", buildPlanned: false }),
    game("d", 45, { result: "Defeat", durationSec: "60", macroScore: NaN, myToonHandle: "2-S2-1-100", myMmr: 4000, myMmrSource: "replay", myBuild: "Beta", opponent: { race: "Terran" } }),
    game("e", 60, { durationSec: -1, macroScore: 101, myMmr: 5010, myMmrSource: "replay" }),
    game("f", 75, { result: "Defeat", macroScore: null }),
    game("g", 90, { result: "Defeat", durationSec: Infinity, macroScore: "20", myBuild: "Alpha" }),
    game("h", 105, { result: "Tie", myBuild: "Beta", buildPlanned: false }),
  ];
  const before = structuredClone(rows);
  const [value] = historySummaryCandidates([...rows].reverse(), { gapMinutes: 15, tz: "America/New_York" });
  expect(value.summary).toMatchObject({ start: "2026-10-26T23:50:00.000Z", end: "2026-10-27T01:35:00.000Z",
    games: 8, wins: 2, losses: 4, unknown: 2, results: "LUWLWLLU", playedMin: 30, durationSamples: 3, durationMissingGames: 5,
    avgMacro: 60, macroSamples: 3, macroMissingGames: 5, buildMissingGames: 2, topBuildsOtherGames: 0,
    longestDecidedStreak: { wins: 1, losses: 2 },
    afterLoss: { wins: 2, losses: 1, decidedGames: 3, winRate: 2 / 3, lossWithoutFollowingDecision: 1 } });
  expect(value.summary.matchups).toEqual([
    { matchup: "PvT", games: 1, wins: 0, losses: 1, unknown: 0 },
    { matchup: "PvZ", games: 7, wins: 2, losses: 3, unknown: 2 },
  ]);
  expect(value.summary.topBuilds).toEqual([
    { name: "Alpha", games: 4, wins: 1, losses: 2, unknown: 1, plannedGames: 1, detectedGames: 2, provenanceUnavailableGames: 1 },
    { name: "Beta", games: 2, wins: 0, losses: 1, unknown: 1, plannedGames: 0, detectedGames: 1, provenanceUnavailableGames: 1 },
  ]);
  expect(value.members.map(row => row.gameId)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  expect(value.members.map(row => row.recordedEndGapSec)).toEqual([null, 900, 900, 900, 900, 900, 900, 900]);
  expect(value.members[0].build).toEqual({ name: "Alpha", provenance: "planned", detectedName: "Gamma" });
  expect(rows).toEqual(before);
});

test("recorded MMR steps stay with each exact own toon and never invent a pre-first-game point", () => {
  const [value] = historySummaryCandidates([
    game("a", 0, { myMmr: 5000, myMmrSource: "replay" }), game("b", 1),
    game("c", 2, { myMmr: 5025 }),
    game("d", 3, { myToonHandle: "2-S2-1-100", myMmr: 4000, myMmrSource: "replay" }),
    game("e", 4, { myMmr: 5010, myMmrSource: "replay" }),
  ], { gapMinutes: 90 });
  const [na, eu] = value.summary.mmr;
  expect(na).toMatchObject({ myToonHandle: "1-S2-1-100", ladderRace: "P", games: 4, samples: 3, missingGames: 1, legacySamples: 1,
    start: 5000, end: 5010, delta: 10, peak: 5025 });
  expect(na.steps.map(row => [row.position, row.value, row.source])).toEqual([[1, 5000, "replay"], [2, null, null], [3, 5025, "legacy"], [5, 5010, "replay"]]);
  expect(eu).toMatchObject({ myToonHandle: "2-S2-1-100", games: 1, samples: 1, start: 4000, end: 4000, delta: null, peak: 4000 });
  expect(eu.steps).toHaveLength(1); expect(eu.steps[0]).toMatchObject({ position: 4, gameId: "d", value: 4000 });
});

test("unknown outcomes bridge membership before decided streak and after-loss denominators", () => {
  const candidates = historySummaryCandidates([
    game("a", 0, { result: "Defeat" }), game("b", 15, { result: "Tie" }),
    game("c", 30, { result: "Defeat" }), game("d", 45),
    game("e", 60, { result: "unknown" }), game("f", 75),
    game("g", 91, { result: "Defeat" }), game("h", 92),
  ], { gapMinutes: 15 });
  expect(candidates.map(value => value.summary.results)).toEqual(["LULWUW", "LW"]);
  expect(candidates[0].summary.longestDecidedStreak).toEqual({ wins: 2, losses: 2 });
  expect(candidates[0].summary.afterLoss).toEqual({ wins: 1, losses: 1, decidedGames: 2, winRate: 0.5, lossWithoutFollowingDecision: 0 });
  expect(candidates[1].summary.afterLoss).toEqual({ wins: 1, losses: 0, decidedGames: 1, winRate: 1, lossWithoutFollowingDecision: 0 });
});

test("no decided follow-up has a null rate, not a fabricated zero percent", () => {
  const summaries = historySummaryCandidates([game("a", 0, { result: "Defeat" }), game("b", 1, { result: "Tie" })], { gapMinutes: 90 });
  expect(summaries[0].summary.afterLoss).toEqual({ wins: 0, losses: 0, decidedGames: 0, winRate: null, lossWithoutFollowingDecision: 1 });
  expect(summaries[0].summary.longestDecidedStreak).toEqual({ wins: 0, losses: 1 });
});

test("duration and macro samples use actual schema bounds without coercion; zero is an observed sample", () => {
  const [value] = historySummaryCandidates([
    game("a", 0, { durationSec: 0, macroScore: 0 }), game("b", 1, { durationSec: 86400, macroScore: 100 }),
    game("c", 2, { durationSec: 1.5, macroScore: NaN }), game("d", 3, { durationSec: 86401, macroScore: Infinity }),
    game("e", 4, { durationSec: false, macroScore: -1 }), game("f", 5, { durationSec: "60", macroScore: "90" }),
  ], { gapMinutes: 90 });
  expect(value.summary).toMatchObject({ playedMin: 1440, durationSamples: 2, durationMissingGames: 4, avgMacro: 50, macroSamples: 2, macroMissingGames: 4 });
  const [missing] = historySummaryCandidates([game("x", 0, { duration: 600, macro_score: 80 })], { gapMinutes: 90 });
  expect(missing.summary).toMatchObject({ playedMin: null, durationSamples: 0, avgMacro: null, macroSamples: 0 });
});

test("uses the actual owner-list build flags; pending/raw private intent is never detector proof", () => {
  const raw = game("a", 0, { myBuild: "DT Rush", buildIntent: { status: "confirmed", applied: true, build: { name: "DT Rush" }, detected: { name: "Charge first" }, notes: "PRIVATE-CHECKIN-NOTE" } });
  const [admitted] = historySummaryCandidates([withOwnerBuildFlags(raw)], { gapMinutes: 90 });
  expect(admitted.members[0].build).toEqual({ name: "DT Rush", provenance: "planned", detectedName: "Charge first" });
  expect(admitted.summary.topBuilds[0]).toMatchObject({ name: "DT Rush", plannedGames: 1, detectedGames: 0, provenanceUnavailableGames: 0 });
  const [unprojected] = historySummaryCandidates([raw], { gapMinutes: 90 });
  expect(unprojected.members[0].build).toEqual({ name: "DT Rush", provenance: "unavailable", detectedName: null });
  expect(JSON.stringify(admitted)).not.toContain("PRIVATE-CHECKIN-NOTE");
  expect(JSON.stringify(unprojected)).not.toContain("PRIVATE-CHECKIN-NOTE");
});

test("top builds retain planned/detected counts and deterministic ties with explicit omitted counts", () => {
  const [value] = historySummaryCandidates([
    game("a", 0, { myBuild: "\u{1f600}", buildPlanned: true }), game("b", 1, { myBuild: "\ue000", buildPlanned: false }),
    game("c", 2, { myBuild: "Alpha" }), game("d", 3, { myBuild: "Alpha", buildPlanned: false }), game("e", 4),
  ], { gapMinutes: 90, topBuildsLimit: 2 });
  expect(value.summary.topBuilds.map(row => row.name)).toEqual(["Alpha", "\ue000"]);
  expect(value.summary.topBuilds[0]).toMatchObject({ games: 2, plannedGames: 0, detectedGames: 1, provenanceUnavailableGames: 1 });
  expect(value.summary).toMatchObject({ topBuildsOtherGames: 1, buildMissingGames: 1 });
  for (const topBuildsLimit of [0, 11, 1.5, NaN]) expect(() => historySummaryCandidates([], { gapMinutes: 90, topBuildsLimit })).toThrow("session_history_top_builds_invalid");
});

test("exact toon strings never merge by case, whitespace, region or opponent fallback", () => {
  const [value] = historySummaryCandidates([
    game("a", 0, { myToonHandle: "A", myMmr: 1000 }), game("b", 1, { myToonHandle: "a", myMmr: 2000 }),
    game("c", 2, { myToonHandle: " A", myMmr: 3000 }),
    game("d", 3, { myToonHandle: null, myMmr: 4000, opponent: { toonHandle: "A", race: "Zerg", mmr: 9000 } }),
  ], { gapMinutes: 90 });
  expect(value.summary.mmr.map(row => [row.myToonHandle, row.start, row.end, row.delta])).toEqual([[" A", 3000, 3000, null], ["A", 1000, 1000, null], ["a", 2000, 2000, null]]);
  expect(value.summary).toMatchObject({ mmrUnattributedGames: 1, mmrUnattributedSamples: 1 });
});

test("one exact account keeps independent ladder race tracks and Random uses the queued race", () => {
  const [value] = historySummaryCandidates([
    game("a", 0, { myMmr: 5000, myMmrSource: "replay" }),
    game("b", 1, { myRace: "Terran", myLadderRace: "Terran", myMmr: 4000, myMmrSource: "replay" }),
    game("c", 2, { myRace: "Protoss", myLadderRace: "Random", myMmr: 3000, myMmrSource: "replay" }),
    game("d", 3, { myRace: "Terran", myLadderRace: "Random", myMmr: 3030, myMmrSource: "replay" }),
    game("e", 4, { myLadderRace: "?", myMmr: 8000, myMmrSource: "replay" }),
  ], { gapMinutes: 90 });
  expect(value.summary.mmr.map(row => [row.ladderRace, row.samples, row.start, row.end, row.delta])).toEqual([[null, 1, 8000, 8000, null], ["P", 1, 5000, 5000, null], ["R", 2, 3000, 3030, 30], ["T", 1, 4000, 4000, null]]);
  expect(value.summary.mmr.find(row => row.ladderRace === "R")?.steps.map(row => row.gameId)).toEqual(["c", "d"]);
});

test("MMR provenance and bounds retain observed legacy samples but reject explicit unavailable/current/invalid values", () => {
  const [value] = historySummaryCandidates([
    game("a", 0, { myMmr: 0, myMmrSource: "replay" }), game("b", 1, { myMmr: 9999 }),
    game("c", 2, { myMmr: 5000, myMmrSource: "unavailable" }), game("d", 3, { myMmr: 5100, myMmrSource: "current-pulse" }),
    game("e", 4, { myMmr: "5200" }), game("f", 5, { myMmr: Infinity }), game("g", 6, { myMmr: -1 }),
    game("h", 7, { myMmr: 10000 }), game("i", 8, { myMmr: 1.5 }),
  ], { gapMinutes: 90 });
  expect(value.summary.mmr[0]).toMatchObject({ games: 9, samples: 2, missingGames: 7, legacySamples: 1, start: 0, end: 9999, delta: 9999, peak: 9999 });
  expect(value.summary.mmr[0].steps).toHaveLength(9);
  expect(value.summary.mmr[0].steps.map(row => row.value)).toEqual([0, 9999, null, null, null, null, null, null, null]);
});

test("natural membership digest is permutation-stable, retains duplicate multiplicity and is not a content ETag", () => {
  const a = game("a\0b", 0), b = game("\u{1f600}", 0);
  const digest = canonicalMemberDigest([a, b]);
  expect(digest).toMatch(/^[a-f0-9]{64}$/); expect(canonicalMemberDigest([b, a])).toBe(digest);
  expect(canonicalMemberDigest([a, a, b])).not.toBe(digest);
  expect(canonicalMemberDigest([{ ...a, gameId: "different" }, b])).not.toBe(digest);
  expect(canonicalMemberDigest([{ ...a, macroScore: 80, durationSec: 300, myBuild: "Other" }, b])).toBe(digest);
  // These are core observable tie fields, not cosmetic data. No stable HTTP
  // identity or summary-content validator is promised by this candidate hash.
  expect(canonicalMemberDigest([{ ...a, myMmr: 5000 }, b])).not.toBe(digest);
});

test("equal core views retain copies even if their cosmetic stats differ, without mutating caller arrays", () => {
  const rows = [game("same", 0, { macroScore: 80 }), game("same", 0, { macroScore: 40 })];
  const before = structuredClone(rows), [value] = historySummaryCandidates(rows, { gapMinutes: 90 });
  expect(value.summary).toMatchObject({ games: 2, wins: 2, avgMacro: 60, macroSamples: 2 });
  expect(value.members.map(row => row.position)).toEqual([1, 2]); expect(rows).toEqual(before);
  expect(canonicalMemberDigest([...rows].reverse())).toBe(value.memberDigest);
});

test("fixed slim output never spreads private or heavy input objects", () => {
  const row = game("a", 0, { userId: "PRIVATE-OWNER-ID", email: "PRIVATE-EMAIL", token: "PRIVATE-TOKEN", buildIntent: { notes: "PRIVATE-NOTE" },
    macroBreakdown: { text: "PRIVATE-HEAVY" }, opponent: { displayName: "PRIVATE-OPPONENT-NAME", toonHandle: "PRIVATE-OPPONENT-TOON", race: "Zerg" } });
  const output = JSON.stringify(historySummaryCandidates([row], { gapMinutes: 90 }));
  for (const secret of ["PRIVATE-OWNER-ID", "PRIVATE-EMAIL", "PRIVATE-TOKEN", "PRIVATE-NOTE", "PRIVATE-HEAVY", "PRIVATE-OPPONENT-NAME", "PRIVATE-OPPONENT-TOON"]) expect(output).not.toContain(secret);
});

test("input safety bounds fail explicitly rather than slicing complete membership", () => {
  expect(historySummaryCandidates([], { gapMinutes: 90 })).toEqual([]);
  for (const rows of [null, {}, [null], [[]], new Array(MAX_SUMMARY_GAMES + 1).fill({})]) expect(() => historySummaryCandidates(rows, { gapMinutes: 90 })).toThrow("session_history_");
  expect(() => historySummaryCandidates([game("a".repeat(201), 0)], { gapMinutes: 90 })).toThrow("session_history_field_limit");
  expect(() => historySummaryCandidates([game("a", 0, { myToonHandle: "a".repeat(65) })], { gapMinutes: 90 })).toThrow("session_history_field_limit");
  const [unicode] = historySummaryCandidates([game("\u{1f600}".repeat(200), 0)], { gapMinutes: 90 });
  expect(unicode.members[0].gameId).toBe("\u{1f600}".repeat(200));
  expect(() => historySummaryCandidates([], { gapMinutes: 14 })).toThrow("session_gap_invalid");
});

test("invalid instants follow the core exclusion domain; duration and timezone never infer membership", () => {
  const rows = [game("a", 0, { startedAt: "2026-10-26T00:00:00Z", durationSec: 86400 }),
    game("b", 15), game("invalid", 16, { date: [new Date(START)] }), game("next-group", 31)];
  const utc = historySummaryCandidates(rows, { gapMinutes: 15, tz: "UTC" });
  const ny = historySummaryCandidates(rows, { gapMinutes: 15, tz: "America/New_York" });
  expect(utc.map(value => value.members.map(row => row.gameId))).toEqual([["a", "b"], ["next-group"]]);
  expect(ny).toEqual(utc);
});

test("one exact toon/race never compares ranked1v1 ratings with team, custom or unknown queues", () => {
  const [value] = historySummaryCandidates([
    game("ranked-a", 0, { myMmr: 5000, myMmrSource: "replay" }), game("ranked-b", 1, { myMmr: 5010, myMmrSource: "replay" }),
    game("team-a", 2, { matchFormat: "team", playerCount: 4, myMmr: 4000, myMmrSource: "replay" }),
    game("team-missing", 3, { matchFormat: "team", playerCount: 4 }),
    game("team-b", 4, { matchFormat: "team", playerCount: 4, myMmr: 4500 }),
    game("custom-a", 5, { isLadderGame: false, myMmr: 6000, myMmrSource: "replay" }),
    game("custom-b", 6, { isLadderGame: false, myMmr: 8000, myMmrSource: "replay" }),
    game("unknown-a", 7, { matchFormat: undefined, playerCount: undefined, isLadderGame: undefined, myLadderRace: undefined, myMmr: 3000 }),
    game("unknown-b", 8, { matchFormat: undefined, playerCount: undefined, isLadderGame: undefined, myLadderRace: undefined, myMmr: 3300 }),
  ], { gapMinutes: 90 });
  expect(value.summary.games).toBe(9);
  expect(value.summary.mmr.map(track => ({ scope: track.ratingScope, race: track.ladderRace, comparable: track.comparable,
    delta: track.delta, samples: track.samples, missing: track.missingGames, legacy: track.legacySamples,
    values: track.steps.map(step => step.value) }))).toEqual([
    { scope: "unknown-unknown", race: null, comparable: false, delta: null, samples: 2, missing: 0, legacy: 2, values: [3000, 3300] },
    { scope: "custom-1v1", race: "P", comparable: false, delta: null, samples: 2, missing: 0, legacy: 0, values: [6000, 8000] },
    { scope: "ranked-1v1", race: "P", comparable: true, delta: 10, samples: 2, missing: 0, legacy: 0, values: [5000, 5010] },
    { scope: "ranked-team", race: "P", comparable: false, delta: null, samples: 2, missing: 1, legacy: 1, values: [4000, null, 4500] },
  ]);
  expect(value.members[0]).toMatchObject({ ratingScope: "ranked-1v1", comparable: true });
  expect(value.members[2]).toMatchObject({ ratingScope: "ranked-team", comparable: false });
});

test("spawned race never supplies missing queue proof or merges with a positively known ladder", () => {
  const [value] = historySummaryCandidates([
    game("played-a", 0, { myLadderRace: undefined, myMmr: 5000 }),
    game("played-b", 1, { myLadderRace: undefined, myMmr: 5100 }),
    game("queued-a", 2, { myLadderRace: "P", myMmr: 5200, myMmrSource: "replay" }),
    game("queued-b", 3, { myLadderRace: "Protoss", myMmr: 5300, myMmrSource: "replay" }),
    game("unsupported-prefix", 4, { myLadderRace: "Potato", myMmr: 9000 }),
  ], { gapMinutes: 90 });
  expect(value.summary.mmr.map(track => [track.ladderRace, track.ratingScope, track.comparable, track.samples, track.delta,
    track.steps.map(step => step.value)])).toEqual([
    [null, "ranked-1v1", false, 3, null, [5000, 5100, 9000]],
    ["P", "ranked-1v1", true, 2, 100, [5200, 5300]],
  ]);
  expect(value.members[0]).toMatchObject({ matchup: "PvZ", ladderRace: null, comparable: false });
});

test("only absent format can use exact two-player fallback and explicit ladder proof is required", () => {
  const [value] = historySummaryCandidates([
    game("fallback-a", 0, { matchFormat: undefined, myMmr: 5000, myMmrSource: "replay" }),
    game("fallback-b", 1, { matchFormat: undefined, myMmr: 5010, myMmrSource: "replay" }),
    game("explicit-team", 2, { matchFormat: "team", playerCount: 2, myMmr: 6000 }),
    game("explicit-other", 3, { matchFormat: "other", playerCount: 2, myMmr: 6100 }),
    game("explicit-null", 4, { matchFormat: null, playerCount: 2, myMmr: 6200 }),
    game("explicit-invalid", 5, { matchFormat: "invalid", playerCount: 2, myMmr: 6300 }),
    game("string-count", 6, { matchFormat: undefined, playerCount: "2", myMmr: 6400 }),
    game("ambiguous-count", 7, { matchFormat: undefined, playerCount: 4, myMmr: 6500 }),
    game("unknown-ladder", 8, { isLadderGame: undefined, myMmr: 6600 }),
    game("string-ladder", 9, { isLadderGame: "true", myMmr: 6700 }),
    game("custom", 10, { isLadderGame: false, myMmr: 6800 }),
    game("ffa", 11, { matchFormat: "ffa", playerCount: 8, myMmr: 6900 }),
  ], { gapMinutes: 90 });
  expect(value.members.map(row => [row.ratingScope, row.comparable])).toEqual([
    ["ranked-1v1", true], ["ranked-1v1", true], ["ranked-team", false], ["ranked-other", false],
    ["ranked-unknown", false], ["ranked-unknown", false], ["ranked-unknown", false], ["ranked-unknown", false],
    ["unknown-1v1", false], ["unknown-1v1", false], ["custom-1v1", false], ["ranked-ffa", false],
  ]);
  expect(value.summary.mmr.filter(track => track.comparable).map(track => track.delta)).toEqual([10]);
  expect(value.summary.mmr.filter(track => !track.comparable).every(track => track.delta === null)).toBe(true);
});

test("queue proof is response content, not a new natural membership identity", () => {
  const ranked = [game("a", 0, { myMmr: 5000 }), game("b", 1, { myMmr: 5010 })];
  const team = ranked.map(row => ({ ...row, matchFormat: "team", playerCount: 4 }));
  const [rankedView] = historySummaryCandidates(ranked, { gapMinutes: 90 });
  const [teamView] = historySummaryCandidates(team, { gapMinutes: 90 });
  expect(teamView.memberDigest).toBe(rankedView.memberDigest);
  expect(rankedView.summary.mmr[0]).toMatchObject({ ratingScope: "ranked-1v1", comparable: true, delta: 10 });
  expect(teamView.summary.mmr[0]).toMatchObject({ ratingScope: "ranked-team", comparable: false, delta: null });
  expect(teamView.summary).not.toEqual(rankedView.summary);
});
