// @ts-nocheck
"use strict";

/**
 * Coverage for the ``opponentPhases`` enrichment branch — the scouting
 * card's pre-game phase forecast ("Usually reaches Mid/Late with
 * Skytoss"). Re-uses the bundled PvZ Adept timing macroBreakdown
 * fixture from ``phaseClassifier.test.js`` as the per-game classifier
 * input so the assertions are anchored to the same calibration data
 * the phase pipeline is regression-tested on.
 */

const fs = require("fs");
const path = require("path");

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "phase", "warpgate_adept_tracking.json"),
    "utf8",
  ),
);

/**
 * Stub GameDetailsService — returns a Map<gameId, { macroBreakdown }>
 * shaped exactly like the real ``GameDetailsService.findMany``. The
 * overlay-live aggregation reads ``blobs.get(gameId).macroBreakdown``
 * to hydrate the per-game phase input.
 */
function stubGameDetails(macroByGameId) {
  return {
    async findMany(_userId, gameIds) {
      const out = new Map();
      for (const gid of gameIds) {
        if (macroByGameId[gid]) {
          out.set(String(gid), { macroBreakdown: macroByGameId[gid] });
        }
      }
      return out;
    },
  };
}

describe("services/overlayLive.buildFromOpponentName — opponentPhases", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({
      uri: mongo.getUri(),
      dbName: "sc2tools_test_overlay_opp_phases",
    });
  });

  afterEach(async () => {
    await db.games.deleteMany({});
    await db.opponents.deleteMany({});
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  async function seedRepeatOpponentGames(count, { result = "Victory" } = {}) {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-future-toon",
      pulseCharacterId: "111000",
      displayNameSample: "Future",
      displayNameHash: "hash",
      race: "Terran",
      gameCount: count,
      wins: count,
      losses: 0,
      lastSeen: new Date(),
      openings: { Macro: count },
    });
    const macroByGameId = {};
    const docs = [];
    for (let i = 0; i < count; i++) {
      const gid = `g-${i + 1}`;
      docs.push({
        userId: "u1",
        gameId: gid,
        result,
        myRace: "Protoss",
        myBuild: "PvT - Phoenix into Robo",
        durationSec: FIXTURE.durationSec,
        date: new Date(Date.now() - (count - i) * 1000),
        opponent: {
          race: "Terran",
          pulseId: "1-S2-1-future-toon",
          pulseCharacterId: "111000",
          displayName: "Future",
          strategy: "Macro",
        },
      });
      macroByGameId[gid] = FIXTURE.macroBreakdown;
    }
    await db.games.insertMany(docs);
    return macroByGameId;
  }

  test("returns an opponentPhases block with the modal final phase + trajectory when the opponent has ≥3 games", async () => {
    const macroByGameId = await seedRepeatOpponentGames(4);
    const svc = new OverlayLiveService(db, {
      gameDetails: stubGameDetails(macroByGameId),
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "Future",
      "Terran",
      111000,
      "Protoss",
      "1-S2-1-future-toon",
    );
    expect(p).toBeTruthy();
    expect(p.opponentPhases).toBeTruthy();
    // The PvZ Adept fixture is calibrated to finalPhase=mid in
    // ``phaseClassifier.test.js`` — all 4 games share that
    // macroBreakdown so the modal final phase matches.
    expect(p.opponentPhases.typicalFinalPhase).toBe("mid");
    expect(p.opponentPhases.trajectory).toMatchObject({
      sampleSize: expect.any(Object),
      crossings: {
        earlyMidAt: 250,
        midAt: 410,
        midLateAt: null,
        lateAt: null,
      },
      finalPhaseDistribution: expect.any(Object),
      durationP95Sec: expect.any(Number),
    });
    // Every game ended in "mid" so finalPhaseDistribution.mid is 4.
    expect(p.opponentPhases.trajectory.finalPhaseDistribution.mid).toBe(4);
  });

  test("omits typicalLateComp when the modal phase is below 'mid'", async () => {
    // Force the modal phase below mid by using a game with very low
    // duration / no production buildings — the classifier yields
    // ``finalPhase=early``. Override the fixture so every game ends
    // in early.
    const earlyMacroBreakdown = {
      bases: [{ name: "Nexus", born_time: 0, died_time: 60 }],
      production_buildings: [],
      stats_events: [],
      unit_timeline: [],
    };
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-future-toon",
      pulseCharacterId: "111000",
      displayNameSample: "Future",
      displayNameHash: "hash",
      race: "Terran",
      gameCount: 3,
      wins: 0,
      losses: 3,
      lastSeen: new Date(),
      openings: { Cheese: 3 },
    });
    const macroByGameId = {};
    const docs = [];
    for (let i = 0; i < 3; i++) {
      const gid = `gx-${i + 1}`;
      docs.push({
        userId: "u1",
        gameId: gid,
        result: "Defeat",
        myRace: "Protoss",
        durationSec: 60,
        date: new Date(Date.now() - (3 - i) * 1000),
        opponent: {
          race: "Terran",
          pulseId: "1-S2-1-future-toon",
          pulseCharacterId: "111000",
          displayName: "Future",
          strategy: "Cheese",
        },
      });
      macroByGameId[gid] = earlyMacroBreakdown;
    }
    await db.games.insertMany(docs);
    const svc = new OverlayLiveService(db, {
      gameDetails: stubGameDetails(macroByGameId),
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "Future",
      "Terran",
      111000,
      "Protoss",
      "1-S2-1-future-toon",
    );
    expect(p.opponentPhases).toBeTruthy();
    expect(p.opponentPhases.typicalFinalPhase).toBe("early");
    expect(p.opponentPhases.typicalLateComp).toBeUndefined();
  });

  test("returns no opponentPhases when the opponent has < 3 games with macroBreakdown", async () => {
    await db.opponents.insertOne({
      userId: "u1",
      pulseId: "1-S2-1-rare-toon",
      pulseCharacterId: "222000",
      displayNameSample: "Rare",
      displayNameHash: "hash",
      race: "Terran",
      gameCount: 2,
      wins: 1,
      losses: 1,
      lastSeen: new Date(),
      openings: { Macro: 2 },
    });
    await db.games.insertMany([
      {
        userId: "u1",
        gameId: "r-1",
        result: "Victory",
        myRace: "Protoss",
        durationSec: 600,
        date: new Date(Date.now() - 2000),
        opponent: {
          race: "Terran",
          pulseId: "1-S2-1-rare-toon",
          pulseCharacterId: "222000",
          displayName: "Rare",
          strategy: "Macro",
        },
      },
      {
        userId: "u1",
        gameId: "r-2",
        result: "Defeat",
        myRace: "Protoss",
        durationSec: 600,
        date: new Date(Date.now() - 1000),
        opponent: {
          race: "Terran",
          pulseId: "1-S2-1-rare-toon",
          pulseCharacterId: "222000",
          displayName: "Rare",
          strategy: "Macro",
        },
      },
    ]);
    const svc = new OverlayLiveService(db, {
      gameDetails: stubGameDetails({
        "r-1": FIXTURE.macroBreakdown,
        "r-2": FIXTURE.macroBreakdown,
      }),
    });
    const p = await svc.buildFromOpponentName(
      "u1",
      "Rare",
      "Terran",
      222000,
      "Protoss",
      "1-S2-1-rare-toon",
    );
    expect(p).toBeTruthy();
    expect(p.opponentPhases).toBeUndefined();
  });

  test("returns no opponentPhases when gameDetails is unavailable (the rest of the payload still lands)", async () => {
    await seedRepeatOpponentGames(4);
    // No ``gameDetails`` injected — macroBreakdown is in the detail
    // store post-v0.4.3 cutover and can't be hydrated, so the phase
    // profile is skipped. The H2H / recent games / RIVAL tag must
    // still render — phase forecast is best-effort.
    const svc = new OverlayLiveService(db);
    const p = await svc.buildFromOpponentName(
      "u1",
      "Future",
      "Terran",
      111000,
      "Protoss",
      "1-S2-1-future-toon",
    );
    expect(p).toBeTruthy();
    expect(p.opponentPhases).toBeUndefined();
    expect(p.headToHead).toEqual({ wins: 4, losses: 0 });
  });
});
