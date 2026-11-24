// @ts-nocheck
"use strict";

// Atlas Flex caps an in-memory sort at 32 MB and does not support
// allowDiskUse. Across the platform, admin Global Trends' momentum windows
// needed ~530 MB of sort memory each and net MMR's pairing window ~141 MB
// (ADR 0097). This suite scales the caps down so a small fixture overflows
// them the same way, then checks that the momentum, net-MMR and opponent
// cards answer within them, exactly as the same cards with window keys
// computed at query time (allowed to spill) answer.

const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { AdminGlobalTrendsService } = require("../src/services/adminGlobalTrends");
const { HISTORY_COLLECTION, WINDOW_INDEXES } = require("../src/services/adminGlobalTrendsHistory");
const { sessionSeriesExpr } = require("../src/services/adminGlobalTrendsScope");
const { mongoOrder } = require("../src/services/sessions");

const CAP_BYTES = 256 * 1024;
const MEMORY_LIMIT_NO_DISK_USE = "QueryExceededMemoryLimitNoDiskUseAllowed";
const HAND = "1-S2-1-4004";
const OTHER = "1-S2-1-7007";
const SHARED = "2-S2-1-300";

let seed = 7;
/** Deterministic pseudo-random integer in [0, n), from the LCG's high bits. */
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };

/** A ranked 1v1 game; an override of `undefined` removes the field. */
function game(overrides) {
  const doc = {
    userId: "u-bulk", myRace: "Protoss", myLadderRace: "Protoss", myMmr: 4000, myMmrSource: "replay",
    isLadderGame: true, playerCount: 2, matchFormat: "1v1", result: "Victory", durationSec: 600, map: "Test Arena",
    opponent: { race: "Zerg", displayName: "Foe", pulseId: "1-S2-1-900", toonHandle: "1-S2-1-900", mmr: 4100 },
    ...overrides,
  };
  for (const [field, value] of Object.entries(doc)) if (value === undefined) delete doc[field];
  return doc;
}

const at = (day, hour, minute) => new Date(Date.UTC(2026, 9, day, hour, minute));

/** Sessions of several players over a few weeks, with the cases the cards
 * treat specially: off-race and team series, undecided games, untrusted and
 * outlier ratings, equal timestamps, rows without a game id, a toon two
 * accounts uploaded (deduplicated) and histories without a toon. */
function bulkGames() {
  const races = ["Protoss", "Terran", "Zerg", "Protoss", "Zerg", "Random"];
  const rows = [];
  races.forEach((race, player) => {
    const toon = player === 5 ? SHARED : `1-S2-1-${100 + player}`;
    let time = Date.UTC(2026, 8, 1 + player, 18, 0);
    const mmr = new Map();
    for (let k = 0; k < 190; k += 1) {
      time += (rand(5) === 0 ? 120 + rand(2000) : 6 + rand(20)) * 60000;
      const offRace = race !== "Random" && rand(10) === 0;
      const ladderRace = offRace ? "Terran" : race;
      const team = rand(20) === 0;
      const ladder = rand(10) !== 0;
      const roll = rand(100);
      const result = roll < 48 ? "Victory" : roll < 96 ? "Defeat" : roll < 98 ? "Tie" : undefined;
      const series = `${ladderRace}|${ladder}|${team}`;
      const before = mmr.get(series) ?? 3000 + 300 * player;
      const delta = (result === "Victory" ? 1 : result === "Defeat" ? -1 : 0) * (rand(15) === 0 ? 400 : 8 + rand(20));
      mmr.set(series, before + delta);
      const foe = rand(30);
      rows.push(game({
        userId: player === 5 && k % 2 ? "u-shared-b" : `u-${player}`,
        gameId: `g-${player}-${String(k).padStart(3, "0")}`, myToonHandle: toon, date: new Date(time),
        myRace: race === "Random" ? ["Protoss", "Terran", "Zerg"][rand(3)] : ladderRace, myLadderRace: ladderRace,
        myMmr: before, myMmrSource: rand(10) === 0 ? "pulse" : "replay",
        isLadderGame: ladder, playerCount: team ? 4 : 2, matchFormat: team ? "2v2" : "1v1", result,
        map: ["Test Arena", "Second Map", "Third Map"][rand(3)],
        opponent: {
          race: ["Protoss", "Terran", "Zerg", "Random"][foe % 4], mmr: 2800 + rand(1500),
          displayName: `Foe ${foe}${k > 120 ? " (renamed)" : ""}`, pulseId: `1-S2-1-${900 + foe}`, toonHandle: `1-S2-1-${900 + foe}`,
        },
      }));
      // The second account of the shared toon re-uploads some replays.
      if (player === 5 && k % 7 === 0) rows.push({ ...rows.at(-1), userId: "u-shared-c", myMmrSource: "pulse" });
    }
  });
  // Equal timestamps without a game id (one account each, as games are
  // unique per account and game id): the session order's fallback fields
  // decide which comes first.
  for (const [userId, result, opponent] of [["u-0", "Defeat", "1-S2-1-951"], ["u-0b", "Victory", "1-S2-1-950"], ["u-0c", "Defeat", "1-S2-1-949"]]) {
    rows.push(game({ userId, gameId: undefined, myToonHandle: "1-S2-1-100", date: at(1, 9, 0), result, opponent: { race: "Terran", toonHandle: opponent } }));
  }
  // Histories without a toon stay with their uploader.
  for (let k = 0; k < 12; k += 1) {
    rows.push(game({ userId: `legacy-${k % 2}`, gameId: `legacy-${k}`, myToonHandle: k % 3 ? undefined : "", date: at(2, 20, k * 7), result: k % 2 ? "Defeat" : "Victory", myMmr: 3500 + k }));
  }
  return rows;
}

/** One player's games, sessioned by hand in the momentum test. */
function handGames() {
  return [
    ["h1", at(20, 10, 0), "Victory"], ["h2", at(20, 10, 10), "Defeat"], ["h3", at(20, 10, 20), "Tie"],
    // Equal timestamps: the game id orders them, h4a first.
    ["h4b", at(20, 10, 30), "Defeat"], ["h4a", at(20, 10, 30), "Victory"],
    // More than 90 minutes later: a new session.
    ["h5", at(20, 13, 40), "Defeat"], ["h6", at(20, 13, 45), "Defeat"],
    // Other series of the same player: a custom game, an off-race game and
    // a ranked team game.
    ["h7", at(20, 13, 50), "Victory", { isLadderGame: false }],
    ["h8", at(20, 10, 5), "Defeat", { myRace: "Terran", myLadderRace: "Terran" }],
    ["h9", at(20, 13, 55), "Victory", { playerCount: 4, matchFormat: "2v2" }],
  ].map(([gameId, date, result, extra]) => game({ userId: "u-hand", gameId, myToonHandle: HAND, date, result, ...extra }))
    // Another player's games between them never join these sessions. Their
    // game ids run against date order, and their opponent was renamed.
    .concat([at(20, 10, 1), at(20, 10, 11), at(20, 10, 31)].map((date, k) => game({
      userId: "u-other", gameId: `o${2 - k}`, myToonHandle: OTHER, date, result: "Victory",
      opponent: { race: "Terran", toonHandle: "1-S2-1-555", displayName: k ? "New name" : "Old name" },
    })));
}

/** The same card with its window keys computed at query time, as before the
 * snapshot stored them (ADR 0097). MongoDB then sorts each window's input in
 * memory, which `allowDiskUse` lets spill. */
function computedKeys(pipeline) {
  const sourceId = pipeline.find((stage) => stage.$set?._id === "$_globalSourceId");
  if (!sourceId) return pipeline; // the roster read
  const [scope, ...rest] = pipeline.filter((stage) => stage !== sourceId);
  const out = [scope, sourceId];
  for (const stage of rest) {
    const window = stage.$setWindowFields;
    if (window?.partitionBy === "$_globalSessionSeries") {
      if (!out.some((s) => s.$addFields?._referenceOrder)) out.push({ $addFields: { _referenceOrder: mongoOrder() } });
      out.push({ $setWindowFields: { ...window, partitionBy: sessionSeriesExpr(), sortBy: { _referenceOrder: 1 } } });
    } else out.push(stage);
  }
  return out;
}

/** A service whose snapshot reads run `computedKeys`, without index hints. */
function referenceService(db, { allowDiskUse }) {
  const service = new AdminGlobalTrendsService({ db });
  service._query = (pipeline, collection, options = {}) => ({
    toArray: () => collection.aggregate(collection === service.history.collection ? computedKeys(pipeline) : pipeline, {
      ...(options.collation ? { collation: options.collation } : {}), ...(allowDiskUse ? { allowDiskUse: true } : {}),
    }).toArray(),
  });
  return service;
}

describe("Global Trends momentum and net-MMR cards on Atlas Flex limits", () => {
  let mongo;
  let db;
  let service;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: [
      "--setParameter", `internalQueryMaxBlockingSortMemoryUsageBytes=${CAP_BYTES}`,
      "--setParameter", `internalDocumentSourceGroupMaxMemoryBytes=${CAP_BYTES}`,
      "--setParameter", "allowDiskUseByDefault=false",
    ] } });
    db = await connect({ uri: mongo.getUri(), dbName: "global_trends_flex_cards" });
    // Production's materialization target has the simple default collation.
    await db.db.createCollection(HISTORY_COLLECTION);
    await db.games.insertMany([...bulkGames(), ...handGames()]);
    service = new AdminGlobalTrendsService({ db });
  });
  afterAll(async () => { await db?.close(); await mongo?.stop(); });
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ["momentum", { sessionGapMinutes: 90 }],
    ["netMmrByMatchup", { tz: "UTC" }],
    ["netMmrByOpponent", {}],
  ])("%s with query-time keys overflows the scaled caps the way production overflows 32 MB", async (method, opts) => {
    await expect(referenceService(db, { allowDiskUse: false }).run(method, {}, opts))
      .rejects.toMatchObject({ codeName: MEMORY_LIMIT_NO_DISK_USE });
  });

  const cohorts = [
    {}, { excluded_players: SHARED }, { player_selection: "include", included_players: `${HAND},${OTHER}` },
    { excluded_races: "Z" }, { player_mmr_min: "3300", include_unrated: "false" },
    { opp_race: "T" }, { since: "2026-09-04", until: "2026-09-20" }, { map: "Second" },
  ];
  test.each(cohorts)("cards answer within the caps exactly as with query-time keys: %p", async (query) => {
    const reference = referenceService(db, { allowDiskUse: true });
    const read = jest.spyOn(service.history.collection, "aggregate");
    for (const [method, opts] of [
      ["momentum", { sessionGapMinutes: 90 }], ["momentum", { sessionGapMinutes: 15 }],
      ["netMmrByMatchup", { tz: "UTC" }], ["netMmrByMatchup", { tz: "America/New_York", groupByOwnRace: true }],
      ["netMmrByOpponent", { limit: 10 }], ["netMmrByOpponent", { opponentRace: "Z", sort: "name", order: "asc" }],
    ]) {
      expect([method, opts, await service.run(method, query, opts)]).toEqual([method, opts, await reference.run(method, query, opts)]);
    }
    for (const [, options] of read.mock.calls) expect(options).not.toHaveProperty("allowDiskUse");
  });

  test("the fixture exercises what the cards count", async () => {
    const momentum = await service.run("momentum", {}, { sessionGapMinutes: 90 });
    expect(momentum.baseline.total).toBeGreaterThan(1000);
    expect(momentum.sessionPositions).toHaveLength(12);
    const matchups = await service.run("netMmrByMatchup", {}, { tz: "UTC" });
    expect(matchups.matchups.length).toBeGreaterThan(2);
    for (const reason of ["terminalGame", "nextUntrustedMyMmr", "outlierSwing", "missingIdentity", "excludedNonRanked1v1"]) {
      expect([reason, matchups.dropped[reason] > 0]).toEqual([reason, true]);
    }
    const opponents = await service.run("netMmrByOpponent", {}, {});
    expect(opponents.totalOpponents).toBeGreaterThan(20);
    expect(opponents.items.some((row) => row.displayName.endsWith("(renamed)"))).toBe(true);
  });

  test("momentum sessions each series separately, in game order", async () => {
    const hand = await service.run("momentum", { player_selection: "include", included_players: HAND }, { sessionGapMinutes: 90 });
    // Ladder series: [h1 W, h2 L, h3 tie, h4a W, h4b L], then [h5 L, h6 L].
    // h7 (custom), h8 (Terran) and h9 (team) each open their own series.
    expect(hand).toEqual({
      sessionGapMinutes: 90,
      baseline: { wins: 4, losses: 5, total: 9, winRate: 4 / 9 },
      postWin: { wins: 0, losses: 2, total: 2, winRate: 0 },
      postLoss: { wins: 1, losses: 1, total: 2, winRate: 0.5 },
      sessionPositions: [
        { pos: 1, wins: 3, losses: 2, total: 5, winRate: 0.6 },
        { pos: 2, wins: 0, losses: 2, total: 2, winRate: 0 },
        { pos: 3, wins: 1, losses: 0, total: 1, winRate: 1 },
        { pos: 4, wins: 0, losses: 1, total: 1, winRate: 0 },
      ],
    });
    const both = await service.run("momentum", { player_selection: "include", included_players: `${HAND},${OTHER}` }, { sessionGapMinutes: 90 });
    // The other player's three wins form one session of their own.
    expect(both.postWin).toEqual({ wins: 2, losses: 2, total: 4, winRate: 0.5 });
    expect(both.sessionPositions.slice(0, 3).map((row) => row.total)).toEqual([6, 3, 2]);
  });

  test("the opponent drilldown names an opponent after the newest game, not the highest game id", async () => {
    const other = await service.run("netMmrByOpponent", { player_selection: "include", included_players: OTHER }, {});
    expect(other.items).toEqual([expect.objectContaining({
      displayName: "New name", opponentRace: "T", pairs: 2, firstPlayed: at(20, 10, 1), lastPlayed: at(20, 10, 11),
    })]);
  });

  test.each([
    ["momentum", { sessionGapMinutes: 90 }, WINDOW_INDEXES.sessions.name, 2],
    ["netMmrByMatchup", { tz: "UTC" }, WINDOW_INDEXES.netMmr.name, 1],
    ["netMmrByOpponent", {}, WINDOW_INDEXES.netMmr.name, 1],
  ])("%s reads its windows' order from its index: no blocking sort", async (method, opts, index, windows) => {
    const read = jest.spyOn(service, "_query");
    service.queries.clear();
    await service.run(method, { excluded_players: OTHER }, opts);
    const [pipeline, collection, options] = read.mock.calls.at(-1);
    expect(options.hint).toBe(index);
    const plan = await collection.aggregate(pipeline, options).explain("queryPlanner");
    const cursor = JSON.stringify(plan.stages[0].$cursor.queryPlanner.winningPlan);
    expect(cursor).toContain(`"indexName":"${index}"`);
    expect(cursor).not.toContain('"stage":"SORT"');
    const stages = plan.stages.map((stage) => Object.keys(stage)[0]);
    expect(stages.slice(1, 1 + windows)).toEqual(Array(windows).fill("$_internalSetWindowFields"));
    expect(stages.slice(0, 1 + windows)).not.toContain("$sort");
  });
});
