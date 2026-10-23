// @ts-nocheck
"use strict";

/**
 * End-to-end coverage for the overlay's opponent tendencies against a
 * real Mongo: favourite opening, predicted strategies, cheese and best
 * answer computed from the games collection (the agent never writes
 * ``opening`` / ``opponents.openings``), wired into both the pre-game
 * enrichment and the post-game payload, plus the enrichment cache key.
 * Pure-compute cases live in ``opponentTendencies.test.js``.
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");
const { applyOverridePipeline, applyOpponentOverridePipeline } = require("../src/services/buildIntentAttribution");

const TOON = "1-S2-1-424242";
const PCID = "424242";

let mongo;
let db;
let svc;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  db = await connect({ uri: mongo.getUri(), dbName: "sc2tools_test_overlay_tendencies" });
  svc = new OverlayLiveService(db);
});

afterEach(async () => {
  await db.games.deleteMany({});
  await db.opponents.deleteMany({});
  svc.clearEnrichmentCache();
});

afterAll(async () => {
  if (db) await db.close();
  if (mongo) await mongo.stop();
});

/**
 * One game vs the shared opponent, ``minutesAgo`` old. No ``opening``
 * field anywhere — exactly what the desktop agent uploads.
 */
function vsOpponent(gameId, minutesAgo, { strategy, oppRace = "Zerg", myBuild, result = "Victory", ...extra } = {}) {
  return {
    userId: "u1",
    gameId,
    result,
    myRace: "Protoss",
    myBuild: myBuild || "PvZ - Stargate Opener",
    map: "Map",
    durationSec: 600,
    date: new Date(Date.now() - minutesAgo * 60000),
    opponent: { race: oppRace, pulseId: TOON, pulseCharacterId: PCID, displayName: "Shared", strategy },
    ...extra,
  };
}

async function seedOpponentRow(extra = {}) {
  await db.opponents.insertOne({
    userId: "u1",
    pulseId: TOON,
    pulseCharacterId: PCID,
    displayNameSample: "Shared",
    race: "Zerg",
    gameCount: 4,
    wins: 2,
    losses: 2,
    lastSeen: new Date(),
    ...extra,
  });
}

function preGame(oppRace = "Zerg") {
  return svc.buildFromOpponentName("u1", "Shared", oppRace, Number(PCID), "Protoss", TOON);
}

test("pre-game intel comes from games when no row carries an `opening`", async () => {
  await seedOpponentRow();
  await db.games.insertMany([
    vsOpponent("a", 1, { strategy: "Zerg - 12 Pool" }),
    vsOpponent("b", 2, { strategy: "Zerg - Hatch First" }),
    vsOpponent("c", 3, { strategy: "Zerg - 12 Pool" }),
  ]);
  const p = await preGame();
  expect(p.favOpening).toEqual({ name: "Zerg - 12 Pool", share: 2 / 3, samples: 2, of: 3 });
  expect(p.predictedStrategies[0].name).toBe("Zerg - 12 Pool");
  expect(p.scouting[0].label).toBe("Zerg - 12 Pool");
  expect(p.cheeseProbability).toBeCloseTo(2 / 3);
  expect(p.cheeseHistory).toEqual({ samples: 2, of: 3 });
  // The per-game scouting envelopes are no longer computed live.
  expect(p).not.toHaveProperty("last5GamesScouting");
});

test("best answer follows the game-derived favourite opening", async () => {
  await seedOpponentRow();
  await db.games.insertMany([
    vsOpponent("a", 1, { strategy: "Zerg - 12 Pool", myBuild: "PvZ - Gate Expand" }),
    vsOpponent("b", 2, { strategy: "Zerg - 12 Pool", myBuild: "PvZ - Gate Expand" }),
    vsOpponent("c", 3, { strategy: "Zerg - 12 Pool", myBuild: "PvZ - Gate Expand", result: "Defeat" }),
  ]);
  const p = await preGame();
  expect(p.favOpening.name).toBe("Zerg - 12 Pool");
  expect(p.bestAnswer).toEqual({ build: "PvZ - Gate Expand", total: 3, winRate: 2 / 3 });
});

test("a display-name-only match never supplies another barcode account's tendencies", async () => {
  await seedOpponentRow({ openings: { "Zerg - 12 Pool": 4 } });
  await db.games.insertMany([1, 2, 3].map((n) =>
    vsOpponent(`old-barcode-${n}`, n, { strategy: "Zerg - 12 Pool" })));
  const p = await svc.buildFromOpponentName("u1", "Shared", "Zerg", null, "Protoss");
  for (const field of ["favOpening", "cheeseProbability", "cheeseHistory", "predictedStrategies", "scouting", "bestAnswer"]) {
    expect(p).not.toHaveProperty(field);
  }
});

test("an unresolved live account uses its own history despite a different same-name opponent row", async () => {
  await seedOpponentRow({ openings: { "Zerg - 12 Pool": 4 } });
  await db.games.insertMany([
    ...[1, 2, 3].map((n) => vsOpponent(`old-${n}`, n, { strategy: "Zerg - 12 Pool" })),
    ...[1, 2].map((n) => vsOpponent(`new-${n}`, n, {
      strategy: "Zerg - Hatch First",
      opponent: { race: "Zerg", pulseId: "1-S2-1-new-account", displayName: "Shared", strategy: "Zerg - Hatch First" },
    })),
  ]);
  const p = await svc.buildFromOpponentName("u1", "Shared", "Zerg", null, "Protoss", "1-S2-1-new-account");
  expect(p.favOpening).toMatchObject({ name: "Zerg - Hatch First", samples: 2, of: 2 });
  expect(p.cheeseProbability).toBeUndefined();
});

test("best answer follows both labels written by real check-in correction pipelines", async () => {
  await seedOpponentRow();
  await db.games.insertMany([1, 2, 3].map((n) =>
    vsOpponent(`corrected-${n}`, n, { strategy: "Zerg - Hatch First", myBuild: "PvZ - Stargate Opener", result: n === 3 ? "Defeat" : "Victory" })));
  const ownBuild = { key: "pvz-gate-expand", name: "PvZ - Gate Expand", slug: null, source: "catalog" };
  const oppBuild = { key: "zerg-12-pool", name: "Zerg - 12 Pool", slug: null, source: "catalog" };
  await db.games.updateMany({ userId: "u1" }, [
    ...applyOverridePipeline(ownBuild, {}),
    ...applyOpponentOverridePipeline(oppBuild, {}),
  ]);
  const p = await preGame();
  expect(p.favOpening.name).toBe(oppBuild.name);
  expect(p.bestAnswer).toEqual({ build: ownBuild.name, total: 3, winRate: 2 / 3 });
});

test("a mixed-matchup opponent only counts games in this matchup", async () => {
  await seedOpponentRow();
  await db.games.insertMany([
    vsOpponent("z1", 1, { strategy: "Zerg - Hatch First" }),
    vsOpponent("t1", 2, { strategy: "Terran - Proxy Reaper", oppRace: "Terran" }),
    vsOpponent("t2", 3, { strategy: "Terran - Proxy Reaper", oppRace: "Terran" }),
    vsOpponent("z2", 4, { strategy: "Zerg - Hatch First" }),
    vsOpponent("t3", 5, { strategy: "Terran - Proxy Reaper", oppRace: "Terran" }),
  ]);
  const zerg = await preGame("Zerg");
  expect(zerg.favOpening).toMatchObject({ name: "Zerg - Hatch First", samples: 2, of: 2 });
  expect(zerg.cheeseProbability).toBeUndefined();

  const terran = await preGame("Terran");
  expect(terran.favOpening).toMatchObject({ name: "Terran - Proxy Reaper", samples: 3, of: 3 });
  expect(terran.cheeseProbability).toBeCloseTo(1);
});

test("check-in corrections count under the corrected build", async () => {
  await seedOpponentRow();
  const correction = {
    status: "confirmed",
    applied: true,
    build: { source: "catalog", key: "zerg-12-pool", name: "Zerg - 12 Pool" },
    detected: { name: "Zerg - Hatch First", slug: null },
  };
  await db.games.insertMany([
    vsOpponent("a", 1, { strategy: "Zerg - 12 Pool", buildIntent: { opponent: correction } }),
    vsOpponent("b", 2, { strategy: "Zerg - 12 Pool", buildIntent: { opponent: correction } }),
    vsOpponent("c", 3, { strategy: "Zerg - Hatch First" }),
  ]);
  const p = await preGame();
  expect(p.favOpening).toMatchObject({ name: "Zerg - 12 Pool", samples: 2, of: 3 });
  expect(p.cheeseHistory).toEqual({ samples: 2, of: 3 });
});

test("the legacy openings map is read only when games carry no labels", async () => {
  await seedOpponentRow({ openings: { "Pool first": 3, Macro: 1 } });
  await db.games.insertMany([
    vsOpponent("a", 1, { strategy: "Zerg - Hatch First" }),
    vsOpponent("b", 2, { strategy: "Zerg - Hatch First" }),
  ]);
  const fromGames = await preGame();
  expect(fromGames.favOpening.name).toBe("Zerg - Hatch First");

  await db.games.updateMany({}, { $unset: { "opponent.strategy": "" } });
  const legacy = await preGame();
  expect(legacy.favOpening).toEqual({ name: "Pool first", share: 0.75, samples: 3, of: 4 });
  expect(legacy.cheeseProbability).toBeCloseTo(0.75);
});

test("post-game intel includes the game just played", async () => {
  await seedOpponentRow();
  const earlier = vsOpponent("earlier", 30, { strategy: "Zerg - 12 Pool" });
  const justPlayed = vsOpponent("now", 0, { strategy: "Zerg - 12 Pool" });
  await db.games.insertMany([earlier, justPlayed]);
  const p = await svc.buildFromGame("u1", justPlayed);
  expect(p.favOpening).toEqual({ name: "Zerg - 12 Pool", share: 1, samples: 2, of: 2 });
  expect(p.cheeseProbability).toBeCloseTo(1);
  expect(p.cheeseHistory).toEqual({ samples: 2, of: 2 });
});

test("post-game history outweighs one cheesy game once there is history", async () => {
  await seedOpponentRow();
  const justPlayed = vsOpponent("now", 0, { strategy: "Zerg - 12 Pool" });
  await db.games.insertMany([
    justPlayed,
    ...[1, 2, 3, 4].map((n) => vsOpponent(`m${n}`, n * 10, { strategy: "Zerg - Hatch First" })),
  ]);
  const p = await svc.buildFromGame("u1", justPlayed);
  expect(p.favOpening.name).toBe("Zerg - Hatch First");
  // 1 cheesy game in 5 is 20%: below the alert.
  expect(p.cheeseProbability).toBeUndefined();
});

test("a first meeting still flags the cheese the game just showed", async () => {
  const justPlayed = vsOpponent("now", 0, { strategy: "Zerg - 12 Pool" });
  await db.games.insertOne(justPlayed);
  const p = await svc.buildFromGame("u1", justPlayed);
  expect(p.favOpening).toBeUndefined();
  expect(p.cheeseProbability).toBeGreaterThanOrEqual(0.4);
  expect(p.cheeseHistory).toBeUndefined();
});

function liveEnvelope(oppRace, gameKey) {
  return {
    type: "liveGameState",
    phase: "match_started",
    capturedAt: 1,
    gameKey,
    user: { name: "Streamer", race: "Protoss" },
    opponent: { name: "Shared", race: oppRace, toonHandle: TOON, profile: { pulse_character_id: Number(PCID) } },
  };
}

test("the enrichment cache keys pulse opponents by matchup, and invalidation still clears them", async () => {
  await seedOpponentRow();
  await db.games.insertMany([
    vsOpponent("z1", 1, { strategy: "Zerg - Hatch First" }),
    vsOpponent("z2", 2, { strategy: "Zerg - Hatch First" }),
    vsOpponent("t1", 3, { strategy: "Terran - Proxy Reaper", oppRace: "Terran" }),
    vsOpponent("t2", 4, { strategy: "Terran - Proxy Reaper", oppRace: "Terran" }),
  ]);
  const zerg = await svc.enrichEnvelope("u1", liveEnvelope("Zerg", "k1"));
  // Same match, race now reads Terran (a Random opponent resolving):
  // a cached Zerg payload must not be served.
  const terran = await svc.enrichEnvelope("u1", liveEnvelope("Terran", "k1"));
  expect(zerg.streamerHistory.favOpening.name).toBe("Zerg - Hatch First");
  expect(terran.streamerHistory.favOpening.name).toBe("Terran - Proxy Reaper");
  expect([...svc._enrichmentCache.keys()].sort()).toEqual([
    `u1|pulse:${PCID}|terran|Protoss`,
    `u1|pulse:${PCID}|zerg|Protoss`,
  ]);

  svc.invalidateEnrichmentForOpponent("u1", "Shared", PCID);
  expect(svc._enrichmentCache.size).toBe(0);
});
