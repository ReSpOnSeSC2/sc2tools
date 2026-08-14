// @ts-nocheck
"use strict";

/**
 * TickerFactsService — the stats-ticker's career-stats + trivia pool.
 *
 * The service's contract: real data only (every fact has a minimum
 * sample size), MMR facts are region-aware (same cross-region guard
 * as the session widget), per-opponent facts exclude barcode names,
 * and the whole compute is TTL-cached per user.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { TickerFactsService } = require("../src/services/tickerFacts");

/** Fixed "now" — 2026-07-19 12:00 UTC — so week/30-day/on-this-day
 *  facts are deterministic. */
const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);
const DAY = 24 * 3600 * 1000;

/** @param {number} daysAgo @param {Record<string, any>} extra */
function game(daysAgo, extra = {}) {
  return {
    userId: "u1",
    gameId: `g-${daysAgo}-${Math.abs(JSON.stringify(extra).length)}-${seq++}`,
    date: new Date(NOW - daysAgo * DAY),
    result: "Victory",
    myRace: "Protoss",
    map: "Alcyone LE",
    durationSec: 700,
    ...extra,
  };
}
let seq = 0;

describe("services/tickerFacts", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_ticker" });
  });

  afterEach(async () => {
    await db.games.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function svc(extraDeps = {}) {
    return new TickerFactsService(db, { now: () => NOW, ...extraDeps });
  }

  function factIds(facts) {
    return facts.map((f) => f.id);
  }

  test("empty account produces an empty pool (never filler)", async () => {
    expect(await svc().factsFor("u1")).toEqual([]);
  });

  test("rich history produces the core career facts", async () => {
    const docs = [];
    // 60 decided games over ~10 months: PvZ-heavy, one favorite map,
    // a recurring nemesis, one signature build, APM + macro data.
    for (let i = 0; i < 60; i += 1) {
      docs.push(
        game(i * 5 + 1, {
          result: i % 3 === 0 ? "Defeat" : "Victory", // 40W-20L
          myBuild: "PvZ - Stargate Opener",
          map: i % 2 === 0 ? "Alcyone LE" : "Oceanborn LE",
          opponent: {
            displayName: i % 4 === 0 ? "NemesisKing" : `Opp${i}`,
            race: "Zerg",
            mmr: 4200 + i,
            toonHandle: "1-S2-1-999",
          },
          apm: 180 + (i % 40),
          macroScore: 60 + (i % 20),
          myMmr: 4200 + i * 2,
          myToonHandle: "1-S2-1-267727",
          durationSec: 600 + i * 10,
        }),
      );
    }
    // Make the nemesis a losing record: NemesisKing games are i % 4
    // === 0 → i = 0,4,8,... force those all Defeats.
    for (const d of docs) {
      if (d.opponent.displayName === "NemesisKing") d.result = "Defeat";
    }
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const ids = factIds(facts);
    expect(ids).toContain("career-record");
    expect(ids).toContain("tracking-since");
    expect(ids).toContain("peak-mmr");
    expect(ids).toContain("most-played-map");
    expect(ids).toContain("nemesis");
    expect(ids).toContain("signature-build");
    expect(ids).toContain("form");
    expect(ids).toContain("apm");
    expect(ids).toContain("avg-length");
    expect(ids).toContain("first-game");
    const nemesis = facts.find((f) => f.id === "nemesis");
    expect(nemesis.text).toContain("NemesisKing");
    const sig = facts.find((f) => f.id === "signature-build");
    // Classifier prefix trimmed for ticker compactness.
    expect(sig.text).toContain("Stargate Opener");
    expect(sig.text).not.toContain("PvZ - Stargate");
  });

  test("peak MMR is region-aware: an old EU peak cannot shadow the NA ladder", async () => {
    const docs = [];
    // Historical EU stint at very high MMR…
    for (let i = 0; i < 15; i += 1) {
      docs.push(
        game(200 + i, {
          myMmr: 5200 + i,
          myToonHandle: "2-S2-1-111",
          opponent: { displayName: `EU${i}`, race: "Zerg", toonHandle: "2-S2-1-5" },
        }),
      );
    }
    // …then a current NA grind at lower MMR.
    for (let i = 0; i < 15; i += 1) {
      docs.push(
        game(1 + i, {
          myMmr: 4300 + i,
          myToonHandle: "1-S2-1-222",
          opponent: { displayName: `NA${i}`, race: "Zerg", toonHandle: "1-S2-1-6" },
        }),
      );
    }
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const peak = facts.find((f) => f.id === "peak-mmr");
    expect(peak).toBeTruthy();
    // NA peak is 4314 — the 5214 EU peak must not leak in.
    expect(peak.text).toContain("4,314");
    expect(peak.text).toContain("NA");
    expect(peak.text).not.toContain("5,214");
  });

  test("all-time facts carry the year — an old peak is never a bare month-day", async () => {
    const docs = [];
    // Current NA grind, well below the record…
    for (let i = 0; i < 14; i += 1) {
      docs.push(
        game(i + 1, {
          myMmr: 5300 + i,
          myToonHandle: "1-S2-1-222",
          opponent: { displayName: `NA${i}`, race: "Zerg", toonHandle: "1-S2-1-6" },
        }),
      );
    }
    // …and the all-time peak from a prior year.
    docs.push(
      game(0, {
        date: new Date(Date.UTC(2024, 11, 29, 3, 0, 0)),
        myMmr: 5842,
        myToonHandle: "1-S2-1-222",
        opponent: { displayName: "OldFoe", race: "Zerg", toonHandle: "1-S2-1-6" },
      }),
    );
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const peak = facts.find((f) => f.id === "peak-mmr");
    expect(peak).toBeTruthy();
    expect(peak.text).toContain("5,842");
    expect(peak.text).toContain("(Dec 29, 2024)");
    expect(peak.text).toContain("542 away right now");
  });

  test("barcode opponents are excluded from name facts but counted as trivia", async () => {
    const docs = [];
    for (let i = 0; i < 30; i += 1) {
      docs.push(
        game(i + 1, {
          result: i % 2 === 0 ? "Victory" : "Defeat",
          opponent: {
            displayName: i < 12 ? "IIllIIllIIll".replace(/l/g, "l") : `Human${i}`,
            race: "Terran",
          },
        }),
      );
    }
    // Make the barcode the most-frequent name — it must still never
    // headline the most-faced fact.
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const mostFaced = facts.find((f) => f.id === "most-faced");
    if (mostFaced) expect(mostFaced.text).not.toContain("IIll");
    const barcodes = facts.find((f) => f.id === "barcodes");
    expect(barcodes).toBeTruthy();
    expect(barcodes.text).toContain("12");
  });

  test("career combat totals aggregate the heavy per-game counters", async () => {
    const docs = [];
    for (let i = 0; i < 12; i += 1) {
      docs.push(
        game(i + 1, {
          macroBreakdown: {
            player_stats: {
              me: {
                units_killed: 600,
                units_produced: 800,
                structures_killed: 60,
                supply_blocked_seconds: 400,
              },
            },
          },
        }),
      );
    }
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const kills = facts.find((f) => f.id === "units-killed");
    expect(kills).toBeTruthy();
    expect(kills.text).toContain("7,200");
    const produced = facts.find((f) => f.id === "units-produced");
    expect(produced.text).toContain("9,600");
    // Protoss race-theming on the produce verb.
    expect(produced.text).toContain("warped in");
    const supply = facts.find((f) => f.id === "supply-blocked");
    expect(supply.text).toContain("build more pylons");
  });

  test("optional deps add playstyle, favorite unit, and season facts", async () => {
    const docs = [];
    for (let i = 0; i < 25; i += 1) {
      docs.push(
        game(i + 1, {
          opponent: { displayName: `O${i}`, race: "Zerg" },
        }),
      );
    }
    await db.games.insertMany(docs);
    const skillFingerprint = {
      compute: jest.fn(async (userId, { matchup }) => ({
        matchup,
        playstyle: "PvZ Creative Tactician",
        axes: [
          { key: "repertoire", position: 100, value: 6, category: "creative" },
          { key: "pace", position: 34, value: 444.42, category: "standard" },
          {
            key: "matchup_balance",
            position: 0,
            value: 14,
            category: "specialist",
          },
        ],
        buildOrders: Array.from({ length: 6 }, (_, i) => ({
          name: `PvZ build ${i + 1}`,
          games: i + 1,
        })),
        matchupWinRates: [
          { matchup: "PvP", winRate: 48 },
          { matchup: "PvT", winRate: 51.5 },
          { matchup: "PvZ", winRate: 62 },
        ],
        matchupSummary: {
          strongestMatchup: "PvZ",
          weakestMatchup: "PvP",
          spread: 14,
          leaderGap: 10.555,
          weakGap: 3.5,
        },
      })),
    };
    const arcade = {
      unitStats: jest.fn(async () => ({
        scannedGames: 25,
        builtByUnit: { Stalker: 1400, Probe: 900 },
        totalUnitsLost: 5000,
        lostGames: 20,
      })),
    };
    const seasons = {
      list: jest.fn(async () => ({
        current: 64,
        items: [
          { number: 64, end: new Date(NOW + 21 * DAY).toISOString() },
          { number: 63, end: new Date(NOW - 60 * DAY).toISOString() },
        ],
      })),
    };
    const facts = await svc({ skillFingerprint, arcade, seasons }).factsFor("u1");
    const play = facts.find((f) => f.id === "playstyle");
    expect(play).toBeTruthy();
    expect(play.text).toBe(
      "PLAYSTYLE (PvZ): PvZ Creative Tactician — 6 PvZ build orders, 7:24.42 average game; PvZ leads both other matchups by at least 10.555 points",
    );
    expect(play.text).not.toMatch(/percentile|benchmark|Master/);
    expect(skillFingerprint.compute).toHaveBeenCalledWith("u1", { matchup: "PvZ" });
    const unit = facts.find((f) => f.id === "favorite-unit");
    expect(unit.text).toContain("Stalker");
    expect(unit.text).toContain("1,400");
    const lost = facts.find((f) => f.id === "units-lost");
    expect(lost.text).toContain("5,000");
    const season = facts.find((f) => f.id === "season-countdown");
    expect(season.text).toContain("SEASON 64");
    expect(season.text).toContain("21 days");
  });

  test("playstyle detail can derive matchup gaps from real win-rate rows", async () => {
    await db.games.insertMany(
      Array.from({ length: 25 }, (_, i) =>
        game(i + 1, {
          opponent: { displayName: `O${i}`, race: "Zerg" },
        }),
      ),
    );
    const skillFingerprint = {
      compute: jest.fn(async (userId, { matchup }) => ({
        matchup,
        playstyle: "Universal Build Perfectionist",
        axes: [
          { key: "repertoire", position: 0, value: 2, category: "grinder" },
          { key: "pace", position: 50, value: 510, category: "standard" },
          { key: "matchup_balance", position: 50, value: 1, category: "universalist" },
        ],
        buildOrders: [{ name: "PvZ build A" }, { name: "PvZ build B" }],
        matchupWinRates: [
          { matchup: "PvP", winRate: 50 },
          { matchup: "PvT", winRate: 49.5 },
          { matchup: "PvZ", winRate: 49 },
        ],
      })),
    };

    const facts = await svc({ skillFingerprint }).factsFor("u1");
    const play = facts.find((fact) => fact.id === "playstyle");
    expect(play.text).toBe(
      "PLAYSTYLE (PvZ): Universal Build Perfectionist — 2 PvZ build orders, 8:30 average game; 1.0-point matchup spread",
    );
  });

  test("playstyle detail names a matchup blind spot without calling it a specialty", async () => {
    await db.games.insertMany(
      Array.from({ length: 25 }, (_, i) =>
        game(i + 1, {
          opponent: { displayName: `O${i}`, race: "Zerg" },
        }),
      ),
    );
    const skillFingerprint = {
      compute: jest.fn(async (userId, { matchup }) => ({
        matchup,
        playstyle: "PvT Blind Spot · Strategic Architect",
        axes: [
          { key: "repertoire", position: 100, value: 7, category: "creative" },
          { key: "pace", position: 100, value: 760, category: "late_game" },
          {
            key: "matchup_balance",
            position: 100,
            value: 15,
            category: "blind_spot",
          },
        ],
        buildOrders: Array.from({ length: 7 }, (_, i) => ({
          name: `PvZ build ${i + 1}`,
          games: 2,
        })),
        matchupWinRates: [
          { matchup: "PvP", winRate: 55 },
          { matchup: "PvT", winRate: 40 },
          { matchup: "PvZ", winRate: 52 },
        ],
        matchupSummary: {
          strongestMatchup: "PvP",
          weakestMatchup: "PvT",
          spread: 15,
          leaderGap: 3,
          weakGap: 12,
        },
      })),
    };

    const facts = await svc({ skillFingerprint }).factsFor("u1");
    const play = facts.find((fact) => fact.id === "playstyle");
    expect(play.text).toBe(
      "PLAYSTYLE (PvZ): PvT Blind Spot · Strategic Architect — 7 PvZ build orders, 12:40 average game; PvT trails both other matchups by at least 12.0 points",
    );
    expect(play.text).not.toMatch(/specialist|leads both/i);
  });

  test("playstyle detail respects an unavailable matchup summary", async () => {
    await db.games.insertMany(
      Array.from({ length: 25 }, (_, i) =>
        game(i + 1, {
          opponent: { displayName: `O${i}`, race: "Zerg" },
        }),
      ),
    );
    const skillFingerprint = {
      compute: jest.fn(async (userId, { matchup }) => ({
        matchup,
        playstyle: "Build Perfectionist",
        axes: [
          { key: "repertoire", position: 0, value: 2, category: "grinder" },
          { key: "pace", position: 50, value: 510, category: "standard" },
          {
            key: "matchup_balance",
            position: null,
            value: null,
            category: null,
          },
        ],
        buildOrders: [{ name: "PvZ build A" }, { name: "PvZ build B" }],
        matchupWinRates: [
          { matchup: "PvP", decidedGames: 3, winRate: 100 },
          { matchup: "PvT", decidedGames: 3, winRate: 0 },
          { matchup: "PvZ", decidedGames: 3, winRate: 50 },
        ],
        matchupSummary: {
          spread: null,
          leaderGap: null,
          strongestMatchup: null,
          weakestMatchup: null,
        },
      })),
    };

    const facts = await svc({ skillFingerprint }).factsFor("u1");
    const play = facts.find((fact) => fact.id === "playstyle");
    expect(play.text).toBe(
      "PLAYSTYLE (PvZ): Build Perfectionist — 2 PvZ build orders, 8:30 average game",
    );
    expect(play.text).not.toContain("matchup spread");
  });

  test("playstyle detail hides provisional build and pace values below their sample gates", async () => {
    await db.games.insertMany(
      Array.from({ length: 25 }, (_, i) =>
        game(i + 1, {
          opponent: { displayName: `O${i}`, race: "Zerg" },
        }),
      ),
    );
    const skillFingerprint = {
      compute: jest.fn(async (userId, { matchup }) => ({
        matchup,
        playstyle: "Profile Still Forming",
        axes: [
          {
            key: "repertoire",
            position: null,
            value: 1,
            category: null,
            sampleSize: 9,
          },
          {
            key: "pace",
            position: null,
            value: 260,
            category: null,
            sampleSize: 9,
          },
          {
            key: "matchup_balance",
            position: null,
            value: null,
            category: null,
          },
        ],
        buildOrders: [{ name: "Provisional build", games: 9 }],
        matchupWinRates: [],
        matchupSummary: {
          spread: null,
          leaderGap: null,
          weakGap: null,
          strongestMatchup: null,
          weakestMatchup: null,
        },
      })),
    };

    const facts = await svc({ skillFingerprint }).factsFor("u1");
    const play = facts.find((fact) => fact.id === "playstyle");
    expect(play.text).toBe("PLAYSTYLE (PvZ): Profile Still Forming");
    expect(play.text).not.toMatch(/build order|average game|matchup spread/i);
  });

  test.each([
    {
      playstyle: "Metronome",
      score: 72,
      explanation:
        "steady macro across recent games, usually at a measured pace",
    },
    {
      playstyle: "Coin-Flip Player",
      score: 28,
      explanation: "macro varied across recent games",
    },
  ])(
    "playstyle fact presents $playstyle consistency as a personal score",
    async ({ playstyle, score, explanation }) => {
      await db.games.insertMany(
        Array.from({ length: 25 }, (_, i) =>
          game(i + 1, {
            opponent: { displayName: `O${i}`, race: "Zerg" },
          }),
        ),
      );
      const skillFingerprint = {
        compute: jest.fn(async (userId, { matchup }) => ({
          matchup,
          games: 25,
          playstyle,
          band: { leagueId: 6, label: "Grandmaster" },
          axes: [
            { key: "macro", label: "Macro", percentile: 68, value: 60 },
            { key: "mechanics", label: "Mechanics", percentile: 63, value: 180 },
            { key: "spending", label: "Spending", percentile: 60, value: 100 },
            { key: "consistency", label: "Consistency", percentile: score, value: 7 },
            { key: "aggression", label: "Aggression", percentile: 50, value: 20 },
            { key: "ladder", label: "MMR context", percentile: 93, value: 5000 },
          ],
        })),
      };

      const facts = await svc({ skillFingerprint }).factsFor("u1");
      const play = facts.find((fact) => fact.id === "playstyle");
      expect(play).toBeTruthy();
      expect(play.text).toBe(
        `PLAYSTYLE (PvZ): ${playstyle} — ${explanation} (consistency score: ${score}/100)`,
      );
      expect(play.text).not.toMatch(/top \d+%/);
      expect(play.text).not.toContain("Grandmaster");
    },
  );

  test("optional-dep failures only shrink the pool, never throw", async () => {
    const docs = [];
    for (let i = 0; i < 25; i += 1) {
      docs.push(game(i + 1, { opponent: { displayName: `O${i}`, race: "Zerg" } }));
    }
    await db.games.insertMany(docs);
    const boom = async () => {
      throw new Error("simulated outage");
    };
    const facts = await svc({
      skillFingerprint: { compute: boom },
      arcade: { unitStats: boom },
      seasons: { list: boom },
    }).factsFor("u1");
    expect(factIds(facts)).toContain("career-record");
    expect(factIds(facts)).not.toContain("playstyle");
  });

  test("results are TTL-cached per user", async () => {
    await db.games.insertMany(
      Array.from({ length: 15 }, (_, i) =>
        game(i + 1, { opponent: { displayName: `O${i}`, race: "Zerg" } }),
      ),
    );
    let now = NOW;
    const s = new TickerFactsService(db, { now: () => now });
    const first = await s.factsFor("u1");
    await db.games.deleteMany({});
    // Within TTL: same pool served even though the collection changed.
    now += 60 * 1000;
    expect(await s.factsFor("u1")).toBe(first);
    // Past TTL: recompute sees the (now empty) collection.
    now += 10 * 60 * 1000;
    expect(await s.factsFor("u1")).toEqual([]);
  });

  test("the 'Game Too Short' classifier catch-all never wins a build fact", async () => {
    const docs = [];
    // 30 short games land in the catch-all with a great "win rate"…
    for (let i = 0; i < 30; i += 1) {
      docs.push(
        game(i + 1, {
          myBuild: "PvZ - Game Too Short",
          durationSec: 40,
        }),
      );
    }
    // …versus a modest real build.
    for (let i = 0; i < 16; i += 1) {
      docs.push(
        game(i + 1, {
          result: i % 2 === 0 ? "Victory" : "Defeat",
          myBuild: "PvZ - Stargate Opener",
        }),
      );
    }
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const sig = facts.find((f) => f.id === "signature-build");
    expect(sig).toBeTruthy();
    expect(sig.text).toContain("Stargate Opener");
    for (const f of facts) {
      expect(f.text).not.toContain("Game Too Short");
    }
  });

  test("unclassified fallbacks never win a build fact", async () => {
    const docs = [];
    // The macro-phase catch-all dominates volume with a hot win rate…
    for (let i = 0; i < 30; i += 1) {
      docs.push(
        game(i + 1, {
          myBuild: "PvZ - Macro Transition (Unclassified)",
        }),
      );
    }
    // …and the bare sentinel piles on more wins…
    for (let i = 0; i < 12; i += 1) {
      docs.push(game(i + 1, { myBuild: "Unclassified - Protoss" }));
    }
    // …versus a modest real build.
    for (let i = 0; i < 16; i += 1) {
      docs.push(
        game(i + 1, {
          result: i % 2 === 0 ? "Victory" : "Defeat",
          myBuild: "PvZ - Stargate Opener",
        }),
      );
    }
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const sig = facts.find((f) => f.id === "signature-build");
    expect(sig).toBeTruthy();
    expect(sig.text).toContain("Stargate Opener");
    for (const f of facts) {
      expect(f.text).not.toContain("Unclassified");
    }
  });

  test("team games are excluded from every fact", async () => {
    const docs = [];
    for (let i = 0; i < 12; i += 1) {
      docs.push(game(i + 1, {}));
      docs.push(game(i + 1, { playerCount: 4, result: "Defeat" }));
    }
    await db.games.insertMany(docs);
    const facts = await svc().factsFor("u1");
    const rec = facts.find((f) => f.id === "career-record");
    expect(rec).toBeTruthy();
    // 12 solo wins, zero losses — the 12 team defeats never count.
    expect(rec.text).toContain("12 W – 0 L");
  });
});
