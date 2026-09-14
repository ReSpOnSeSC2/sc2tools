"use strict";

const { analyzeSummary } = require("../src/services/trendsExplorerStats");

/** @param {string} gameId @param {Record<string,any>} [extra] */
function game(gameId, extra = {}) {
  return {
    userId: "u1", gameId, playerId: "1-S2-1-11", myToonHandle: "1-S2-1-11",
    date: new Date("2026-09-01T12:00:00.000Z"), result: "Victory", durationSec: 600,
    myRace: "Protoss", myLadderRace: "Protoss", isLadderGame: true, playerCount: 2,
    matchFormat: "1v1", myBuild: "Blink", myMmr: 4000, myMmrSource: "replay", matches: true,
    opponent: { toonHandle: "1-S2-1-22", race: "Terran", mmr: 4200, mmrSource: "replay" },
    ...extra,
  };
}

/** @param {any} result @param {string} key */
function row(result, key) { return result.rows.find((/** @type {any} */ value) => value.key === key); }

describe("Trends explorer exact summary calculations", () => {
  test("MMR difference uses both replay ratings, centered bands, and decided-game denominators", () => {
    const result = analyzeSummary("mmr-gap", [
      game("win", { opponent: { mmr: 4100, mmrSource: "replay" } }),
      game("loss", { result: "Defeat", opponent: { mmr: 4299, mmrSource: "replay" } }),
      game("tie", { result: "Tie", opponent: { mmr: 4200, mmrSource: "replay" } }),
      game("next", { opponent: { mmr: 4300, mmrSource: "replay" } }),
      game("lower", { opponent: { mmr: 3899, mmrSource: "replay" } }),
      game("old-own", { myMmrSource: undefined }),
      game("current-opponent", { opponent: { mmr: 4200, mmrSource: "pulse" } }),
      game("legacy-opponent", { opponent: { mmr: 4200 } }),
      game("filtered", { matches: false }),
      game("resumed", { isResumedFromReplay: true }),
    ], { gapWidth: 200 });
    expect(result.eligibleGames).toBe(5);
    expect(result.rows.map((r) => r.key)).toEqual(["gap:-300:-100", "gap:100:300", "gap:300:500"]);
    expect(row(result, "gap:100:300")).toMatchObject({ games: 3, wins: 1, losses: 1, decided: 2, winRate: 0.5, gameKeys: ["u1|win", "u1|loss", "u1|tie"] });
  });

  test("unknown outcomes are counted and never treated as a defeat or a zero-percent win rate", () => {
    const result = analyzeSummary("mmr-gap", [game("tie", { result: "Tie" }), game("unknown", { result: "Unknown" })]);
    expect(result.rows[0]).toMatchObject({ games: 2, wins: 0, losses: 0, decided: 0, winRate: null, decidedPlayers: 0 });
  });

  test("periods honor inclusive final milliseconds, overlap membership, and missing date coverage", () => {
    const options = {
      aSince: new Date("2026-09-01T00:00:00.000Z"), aUntil: new Date("2026-09-02T23:59:59.999Z"),
      bSince: new Date("2026-09-02T00:00:00.000Z"), bUntil: new Date("2026-09-03T23:59:59.999Z"),
    };
    const result = analyzeSummary("periods", [
      game("before", { date: "2026-08-31T23:59:59.999Z" }),
      game("first", { date: options.aSince }),
      game("shared", { date: options.aUntil, result: "Defeat" }),
      game("last", { date: options.bUntil }),
      game("after", { date: "2026-09-04T00:00:00.000Z" }),
      game("invalid", { date: "not-a-date" }),
      game("filter", { matches: false }),
    ], options);
    expect(result.eligibleGames).toBe(3);
    expect(row(result, "a")).toMatchObject({ games: 2, gameKeys: ["u1|first", "u1|shared"] });
    expect(row(result, "b")).toMatchObject({ games: 2, gameKeys: ["u1|shared", "u1|last"] });
    expect(/** @type {any} */ (result).breakdown.find((/** @type {any} */ b) => b.group === "a" && b.kind === "build" && b.label === "Blink"))
      .toMatchObject({ games: 2, decided: 2, winRate: 0.5, gameKeys: ["u1|first", "u1|shared"] });
  });

  test("historical MMR groups use disjoint adjacent ranges and never replace missing game ratings with current values", () => {
    const result = analyzeSummary("groups", [
      game("low", { myMmr: 3500 }), game("boundary", { myMmr: 4000 }), game("high", { myMmr: 4500 }),
      game("legacy", { myMmr: 4000, myMmrSource: undefined, currentMmr: 4000 }),
      game("outside", { myMmr: 4501 }),
    ], { groupMode: "mmr", aMin: 3500, aMax: 4000, bMin: 4000, bMax: 4500 });
    expect(result.eligibleGames).toBe(2);
    expect(row(result, "a")).toMatchObject({ games: 1, avgMmr: 3500 });
    expect(row(result, "b")).toMatchObject({ games: 1, avgMmr: 4000 });
  });

  test("MMR gaps recover legacy ratings only from replay detail evidence, never stored Pulse approximations", () => {
    const recovered = game("recovered", { myMmr: 6000, myMmrSource: undefined,
      opponent: { mmr: 7000, mmrSource: "pulse", mmrLookupAttempted: true },
      trendsExplorerDetail: { ratings: { myMmr: 4000, opponentMmr: 4100 } } });
    const primary = game("primary", { opponent: { mmr: 4200, mmrSource: "replay" },
      trendsExplorerDetail: { ratings: { myMmr: 2000, opponentMmr: 6000 } } });
    const invalid = [7, 499, 10000, 4000.5, "4000"].map((rating, index) => game(`invalid-${index}`, {
      myMmrSource: undefined, trendsExplorerDetail: { ratings: { myMmr: rating, opponentMmr: 4100 } },
    }));
    const result = analyzeSummary("mmr-gap", [recovered, primary, ...invalid]);
    expect(result.eligibleGames).toBe(2);
    expect(row(result, "gap:100:300")).toMatchObject({ games: 2, avgMmr: 4000, gameKeys: ["u1|recovered", "u1|primary"] });
  });

  test("equal-account weighting differs from equal-game weighting without changing exact totals or ties", () => {
    const records = [game("w1"), game("w2"), game("w3"), game("w4"),
      game("loss", { playerId: "1-S2-1-33", result: "Defeat" }),
      game("tie", { playerId: "1-S2-1-44", result: "Tie" })];
    const options = { groupMode: "players", aPlayers: ["1-S2-1-11", "1-S2-1-33", "1-S2-1-44"], bPlayers: ["1-S2-1-999"] };
    const weighted = analyzeSummary("groups", records, { ...options, weight: "players" });
    const regular = analyzeSummary("groups", records, { ...options, weight: "games" });
    expect(row(weighted, "a")).toMatchObject({ games: 6, wins: 4, losses: 1, decided: 5, players: 3, decidedPlayers: 2, winRate: 0.5 });
    expect(row(regular, "a")).toMatchObject({ games: 6, winRate: 0.8 });
    expect(row(regular, "b")).toMatchObject({ games: 0, winRate: null, players: 0 });
  });

  test("breaks subtract the prior end from the current start and preserve filtered-out predecessors", () => {
    const records = [
      game("current", { date: "2026-09-01T12:24:00Z", durationSec: 600 }),
      game("first", { date: "2026-09-01T12:00:00Z", matches: false }),
      game("actual-prior", { date: "2026-09-01T12:12:00Z", result: "Defeat", matches: false }),
    ];
    const result = analyzeSummary("breaks", records, { after: "loss" });
    expect(result.eligibleGames).toBe(1);
    expect(row(result, "2-5")).toMatchObject({ games: 1, gameKeys: ["u1|current"] });
    expect(analyzeSummary("breaks", records, { after: "win" }).eligibleGames).toBe(0);
  });

  test("break interval boundaries are disjoint and exact starts take precedence over duration estimates", () => {
    const offsets = [0, 119, 120, 299, 300, 899, 900, 1799, 1800, 3599, 3600, 14399, 14400];
    const records = offsets.flatMap((seconds, index) => {
      const identity = `1-S2-1-${100 + index}`;
      return [
        game(`prior-${index}`, { playerId: identity, date: "2026-09-01T12:00:00Z", matches: false, durationSec: undefined }),
        game(`current-${index}`, { playerId: identity, startedAt: new Date(Date.parse("2026-09-01T12:00:00Z") + seconds * 1000), date: "2026-09-02T12:00:00Z", durationSec: 1 }),
      ];
    });
    const result = analyzeSummary("breaks", records);
    expect(result.eligibleGames).toBe(offsets.length);
    expect(result.rows.map((r) => r.games)).toEqual([2, 2, 2, 2, 2, 2, 1]);
  });

  test("break sequences do not cross account, race, selected race, ranked status, format or size", () => {
    const variants = [
      { playerId: "1-S2-1-99" }, { myRace: "Terran" }, { myLadderRace: "Random" },
      { isLadderGame: false }, { matchFormat: "team" }, { playerCount: 4 },
    ];
    for (const change of variants) {
      const records = [game("prior", { date: "2026-09-01T12:00:00Z", matches: false }),
        game("next", { date: "2026-09-01T12:12:00Z", ...change })];
      expect(analyzeSummary("breaks", records).eligibleGames).toBe(0);
    }
  });

  test("unknown accounts, overlapping times and invalid starts cannot manufacture rest periods", () => {
    const records = [game("prior", { date: "2026-09-01T12:00:00Z", matches: false }),
      game("overlap", { date: "2026-09-01T12:01:00Z", durationSec: 600 }),
      game("no-duration", { date: "2026-09-01T12:02:00Z", durationSec: undefined }),
      game("future-start", { date: "2026-09-01T12:03:00Z", startedAt: "2026-09-01T12:04:00Z" })];
    expect(analyzeSummary("breaks", records).eligibleGames).toBe(0);
    expect(analyzeSummary("breaks", records.map((g) => ({ ...g, playerId: undefined, myToonHandle: undefined }))).eligibleGames).toBe(0);
  });

  test("intervening games in another race or mode cannot be counted as rest", () => {
    for (const change of [{ myRace: "Terran", myLadderRace: "Terran" }, { isLadderGame: false }, { matchFormat: "team", playerCount: 4 }]) {
      const records = [game("first", { date: "2026-09-01T12:00:00Z", matches: false }),
        game("intervening", { date: "2026-09-01T12:12:00Z", matches: false, ...change }),
        game("current", { date: "2026-09-01T12:24:00Z" })];
      expect(analyzeSummary("breaks", records).eligibleGames).toBe(0);
    }
  });

  test("rematches count full chronology and stable IDs rather than shared opponent display names", () => {
    const opponent = { toonHandle: "1-S2-1-22", race: "Terran", displayName: "||||||||" };
    const result = analyzeSummary("rematches", [
      game("fourth", { date: "2026-09-04T12:00:00Z", opponent }),
      game("first", { date: "2026-09-01T12:00:00Z", opponent, matches: false }),
      game("second", { date: "2026-09-02T12:00:00Z", opponent, matches: false }),
      game("third", { date: "2026-09-03T12:00:00Z", opponent }),
      game("different-id", { date: "2026-09-05T12:00:00Z", opponent: { ...opponent, toonHandle: "1-S2-1-33" } }),
      game("name-only", { date: "2026-09-06T12:00:00Z", opponent: { displayName: "||||||||" } }),
    ]);
    expect(result.eligibleGames).toBe(3);
    expect(result.rows.map((r) => r.games)).toEqual([1, 0, 1, 1]);
    expect(row(result, "fourth-plus").gameKeys).toEqual(["u1|fourth"]);
  });

  test("rematch prior-result filter refers to the prior meeting, not the previous game", () => {
    const records = [game("first", { date: "2026-09-01T12:00:00Z", result: "Defeat", matches: false }),
      game("unrelated", { date: "2026-09-02T12:00:00Z", opponent: { toonHandle: "1-S2-1-33", race: "Terran" }, matches: false }),
      game("second", { date: "2026-09-03T12:00:00Z" })];
    const result = analyzeSummary("rematches", records, { after: "loss" });
    expect(result.eligibleGames).toBe(1);
    expect(row(result, "second").gameKeys).toEqual(["u1|second"]);
    expect(analyzeSummary("rematches", records, { after: "win" }).eligibleGames).toBe(0);
  });

  test("rematches join verified toon/Pulse aliases through enrichment without joining conflicting identities", () => {
    const records = [
      game("first", { date: "2026-09-01T12:00:00Z", opponent: { pulseId: "123", race: "Terran" }, matches: false }),
      game("second", { date: "2026-09-02T12:00:00Z", opponent: { toonHandle: "1-S2-1-22", pulseCharacterId: "123", race: "Terran" } }),
      game("third", { date: "2026-09-03T12:00:00Z" }),
    ];
    const result = analyzeSummary("rematches", records);
    expect(row(result, "second").gameKeys).toEqual(["u1|second"]);
    expect(row(result, "third").gameKeys).toEqual(["u1|third"]);
    const ambiguous = analyzeSummary("rematches", [...records,
      game("conflict", { date: "2026-09-04T12:00:00Z", opponent: { toonHandle: "1-S2-1-33", pulseCharacterId: "123", race: "Terran" } })]);
    expect(row(ambiguous, "first").gameKeys).toEqual(["u1|second", "u1|conflict"]);
    expect(row(ambiguous, "second").gameKeys).toEqual(["u1|third"]);
  });

  test("rematches keep own identity, selected race, mode and opponent race separate", () => {
    const variants = [{ playerId: "1-S2-1-99" }, { myRace: "Terran" }, { myLadderRace: "Random" },
      { isLadderGame: false }, { matchFormat: "team" }, { playerCount: 4 },
      { opponent: { toonHandle: "1-S2-1-22", race: "Zerg" } }];
    for (const variant of variants) {
      const result = analyzeSummary("rematches", [game("first", { date: "2026-09-01T12:00:00Z", matches: false }),
        game("next", { date: "2026-09-02T12:00:00Z", ...variant })]);
      expect(row(result, "first").gameKeys).toEqual(["u1|next"]);
    }
  });

  test("each drilldown membership matches its aggregate, including ties and comparison breakdowns", () => {
    const records = [game("a"), game("b", { result: "Tie" }), game("c", { result: "Defeat" })];
    const result = analyzeSummary("groups", records, { aMin: 3900, aMax: 4100, bMin: 4200, bMax: 5000 });
    for (const value of [...result.rows, ...(/** @type {any} */ (result).breakdown || [])]) {
      expect(value.gameKeys).toHaveLength(value.games);
      expect(new Set(value.gameKeys).size).toBe(value.games);
    }
    expect(records[0].date).toEqual(new Date("2026-09-01T12:00:00Z"));
    expect(records.map((g) => g.gameId)).toEqual(["a", "b", "c"]);
  });
});
