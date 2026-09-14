// @ts-nocheck
"use strict";

const { extractDetailSummary, detailSummaryUpdate, analyzeDetail } = require("../src/services/trendsExplorerDetail");

const base = (unit_id, born_time, died_time = 1200, name = "Nexus") => ({ unit_id, born_time, died_time, name });
const game = (id, fields = {}) => ({
  userId: "u1", playerId: "p1", gameId: id, date: "2026-09-08T12:00:00Z",
  myRace: "Protoss", opponent: { race: "Terran" }, matchFormat: "1v1", playerCount: 2,
  durationSec: 1000, result: "Victory", ...fields,
});

describe("Trends detail extraction", () => {
  test("preserves raw observed times, choosing the earliest known milestone without guessing missing values", () => {
    const summary = extractDetailSummary({ buildLog: [
      "[4:00] Stalker", "[2:39] Stalker", "[3:12] Blink", "[1:15] Gateway",
      "[1:99] Oracle", "junk", "[2:30] MadeUpUnit", "[2:50] __proto__",
    ] });
    expect(summary.build.milestones).toEqual([
      { id: "first:Blink", sec: 192 }, { id: "first:Gateway", sec: 75 }, { id: "first:Stalker", sec: 159 },
    ]);
    expect(summary.bases).toBeUndefined();
    expect(summary.leads).toBeUndefined();
    const result = analyzeDetail("execution", [game("g", { trendsExplorerDetail: summary })], { milestone: "first:Stalker" });
    expect(result.options.milestones).toContainEqual({ id: "first:Stalker", label: "First Stalker completed" });
    expect(result.options.milestones).toContainEqual({ id: "first:Gateway", label: "First Gateway started" });
    expect(result.rows[0].medianSec).toBe(159);
  });

  test("counts distinct simultaneous operational bases and never promotes town-hall morphs or destroyed-base replacements", () => {
    const summary = extractDetailSummary({ macroBreakdown: { bases: [
      base(1, 0, 1200, "Hatchery"), base(1, 180, 1200, "Lair"), base(1, 400, 1200, "Hive"),
      base(2, 150, 200, "Hatchery"), base(3, 300, 1200, "Hatchery"), base(4, 500, 1200, "Hatchery"),
    ] } });
    expect(summary.bases.milestones).toEqual([{ id: "second-base", sec: 150 }, { id: "third-base", sec: 500 }]);
  });

  test("does not invent the starting base or identities in an incomplete lifetime stream", () => {
    expect(extractDetailSummary({ macroBreakdown: { bases: [base(1, 100), base(2, 200), base(3, 300)] } }).bases.milestones).toEqual([]);
    expect(extractDetailSummary({ macroBreakdown: { bases: [base(undefined, 0), base(undefined, 200), base(undefined, 300)] } }).bases.milestones).toEqual([]);
  });

  test("requires same-tick snapshots at or before the checkpoint and honors the legacy30-second cadence", () => {
    const summary = extractDetailSummary({ macroBreakdown: {
      stats_events: [
        { time: 270, food_workers: 35, army_value: 1200 },
        { time: 299, food_workers: 100, army_value: 9000 },
        { time: 301, food_workers: 200, army_value: 9900 },
        { time: 440, food_workers: 50, army_value: 2200 },
        { time: 715, food_workers: 60 },
      ],
      opp_stats_events: [
        { time: 270, food_workers: 30, army_value: 900 },
        { time: 298, food_workers: 1, army_value: 0 },
        { time: 301, food_workers: 0, army_value: 0 },
        { time: 440, food_workers: 30, army_value: 900 },
        { time: 715, food_workers: 58, army_value: 0 },
      ],
    } });
    expect(summary.leads.snapshots).toEqual([
      { second: 300, at: 270, workers: [35, 30], army: [1200, 900] },
      { second: 720, at: 715, workers: [60, 58], army: null },
    ]);
  });

  test("treats absent and malformed metrics as missing but a recorded zero as real", () => {
    const summary = extractDetailSummary({ macroBreakdown: {
      stats_events: [{ time: 300, food_workers: 0, army_value: null }],
      opp_stats_events: [{ time: 300, food_workers: 0, army_value: 0 }],
    } });
    expect(summary.leads.snapshots[0]).toEqual({ second: 300, at: 300, workers: [0, 0], army: null });
    expect(extractDetailSummary({ macroBreakdown: {} }).leads).toEqual({ available: false, snapshots: [] });
  });

  test("only recovers integer replay-player ratings in the supported rating range", () => {
    expect(extractDetailSummary({ macroBreakdown: { player_stats: { me: { mmr: 4100 }, opponent: { mmr: 4299 } } } }).ratings)
      .toEqual({ myMmr: 4100, opponentMmr: 4299 });
    for (const invalid of [null, "4200", 499, 10000, 4000.5, Infinity]) {
      expect(extractDetailSummary({ macroBreakdown: { player_stats: { me: { mmr: invalid }, opponent: { mmr: invalid } } } }).ratings)
        .toEqual({ myMmr: null, opponentMmr: null });
    }
  });

  test("partial source patches leave unrelated summary branches intact", () => {
    expect(detailSummaryUpdate({ apmCurve: {} })).toEqual({});
    expect(detailSummaryUpdate({ buildLog: [] })).toEqual({
      "trendsExplorerDetail.version": 1,
      "trendsExplorerDetail.build": { available: false, milestones: [] },
      trendsExplorerRevision: expect.any(String),
    });
    expect(Object.keys(detailSummaryUpdate({ macroBreakdown: {} }))).not.toContain("trendsExplorerDetail.build");
  });
});

describe("Trends detail analysis", () => {
  const timed = (id, sec, fields = {}) => game(id, {
    trendsExplorerDetail: extractDetailSummary({ buildLog: [`[${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}] Stalker`] }),
    ...fields,
  });

  test("reports weekly quartiles and separate actual win/loss timings while preserving every game key", () => {
    const records = [timed("a", 100), timed("b", 120), timed("c", 140, { result: "Defeat" }), timed("d", 160, { result: "Defeat" })];
    const result = analyzeDetail("execution", records, { milestone: "first:Stalker" });
    expect(result.eligibleGames).toBe(4);
    expect(result.rows).toEqual([expect.objectContaining({
      key: "2026-09-07", games: 4, wins: 2, losses: 2, decided: 4, winRate: 0.5,
      medianSec: 120, p25Sec: 100, p75Sec: 140, winMedianSec: 100, lossMedianSec: 140,
      gameKeys: ["u1|a", "u1|b", "u1|c", "u1|d"],
    })]);
  });

  test("equal-player distributions and rates prevent prolific accounts from dominating without altering actual counts", () => {
    const records = [timed("a", 100), timed("b", 100), timed("c", 100), timed("d", 500, { playerId: "p2", result: "Defeat" })];
    expect(analyzeDetail("execution", records, { milestone: "first:Stalker" }).rows[0].winRate).toBe(0.75);
    expect(analyzeDetail("execution", records, { milestone: "first:Stalker", weight: "players" }).rows[0])
      .toMatchObject({ games: 4, players: 2, wins: 3, losses: 1, winRate: 0.5 });
  });

  test("separates missing history and unobserved milestones from valid zero-second values", () => {
    const records = [timed("a", 0), game("missing"), game("no-unit", { trendsExplorerDetail: extractDetailSummary({ buildLog: ["[0:00] Nexus"] }) })];
    const result = analyzeDetail("execution", records, { milestone: "first:Stalker" });
    expect(result).toMatchObject({ eligibleGames: 1, sourceGames: 2, detailedGames: 2 });
    expect(result.rows[0].medianSec).toBe(0);
  });

  test("leads exclude short games, nonduels, unknown races and absent metrics, while retaining ties separately", () => {
    const detail = extractDetailSummary({ macroBreakdown: {
      stats_events: [{ time: 480, food_workers: 60, army_value: 3000 }],
      opp_stats_events: [{ time: 480, food_workers: 50, army_value: 3500 }],
    } });
    const records = [
      game("win", { trendsExplorerDetail: detail }),
      game("tie", { result: "Tie", trendsExplorerDetail: detail }),
      game("short", { durationSec: 479, trendsExplorerDetail: detail }),
      game("team", { matchFormat: "team", trendsExplorerDetail: detail }),
      game("ffa", { matchFormat: "ffa", trendsExplorerDetail: detail }),
      game("unknown", { myRace: "Unknown", trendsExplorerDetail: detail }),
      game("legacy", { matchFormat: undefined, playerCount: 2, result: "Defeat", trendsExplorerDetail: detail }),
    ];
    const workers = analyzeDetail("leads", records, { checkpoint: 480, metric: "workers" });
    expect(workers.eligibleGames).toBe(3);
    expect(workers.rows[2]).toMatchObject({ games: 3, decided: 2, wins: 1, losses: 1, winRate: 0.5, medianGap: 10 });
    const army = analyzeDetail("leads", records, { checkpoint: 480, metric: "army" });
    expect(army.rows[0]).toMatchObject({ games: 3, medianGap: -500 });
    expect(army.rows[1].winRate).toBeNull();
  });
});
