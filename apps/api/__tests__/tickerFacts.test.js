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
        playstyle: "Tempo Attacker",
        band: { leagueId: 5, label: "Master" },
        axes: [
          { key: "aggression", label: "Aggression", percentile: 82, value: 1 },
          { key: "ladder", label: "MMR context", percentile: 99, value: 1 },
        ],
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
    expect(play.text).toContain("Tempo Attacker");
    expect(play.text).toContain("PvZ");
    // ladder axis excluded from "strongest axis" — aggression wins.
    expect(play.text.toLowerCase()).toContain("aggression");
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
