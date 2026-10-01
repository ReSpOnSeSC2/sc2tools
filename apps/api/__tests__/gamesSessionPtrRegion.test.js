// @ts-nocheck
"use strict";

/**
 * Session widget + sticky MMR vs Public Test Realm (PTR) games.
 *
 * PTR toon handles (``98-``) now carry their own "PTR" region label so
 * PTR games survive the analyzer's region filters. The session widget
 * is a LADDER widget, though: it pins SC2Pulse lookups by region and
 * labels ladder MMR, and SC2Pulse has no PTR ladder. A PTR game must
 * therefore read as region-unknown here, exactly as it did before the
 * label existed, and never pull the streamer's region off NA/EU/....
 */

const { MongoMemoryServer } = require("mongodb-memory-server");

const { connect } = require("../src/db/connect");
const { GamesService } = require("../src/services/games");
const { UsersService } = require("../src/services/users");

const NA_ME = "1-S2-1-30230";
const PTR_ME = "98-S2-1-30230";
const PTR_OPP = "98-S2-1-25175";

describe("session widget ignores PTR as a region", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "games_session_ptr" });
  });

  afterEach(async () => {
    await Promise.all([db.games.deleteMany({}), db.users.deleteMany({})]);
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  /** A game ``minutesAgo`` minutes in the past, inside the active session. */
  function sessionGame(userId, gameId, minutesAgo, myToonHandle, extra = {}) {
    return {
      userId,
      gameId,
      result: "Victory",
      date: new Date(Date.now() - minutesAgo * 60 * 1000),
      myToonHandle,
      opponent: {
        toonHandle: myToonHandle === PTR_ME ? PTR_OPP : "1-S2-1-99999",
      },
      ...extra,
    };
  }

  function pulseStub(result) {
    const calls = [];
    return {
      calls,
      getCurrentMmrForAny: jest.fn(async (ids, opts) => {
        calls.push({ ids: [...ids], opts });
        return result;
      }),
    };
  }

  test("a PTR latest game does not move preferredRegion off the profile's NA", async () => {
    await db.games.insertMany([
      sessionGame("u-ptr-1", "na", 90, NA_ME, { myMmr: 4000 }),
      sessionGame("u-ptr-1", "ptr", 10, PTR_ME, { myMmr: 3200 }),
    ]);
    const pulseMmr = pulseStub({ mmr: 4050, region: "NA" });
    const svc = new GamesService(db, {
      users: { getProfile: async () => ({ region: "na", pulseIds: [NA_ME] }) },
      pulseMmr,
    });

    const out = await svc.todaySession("u-ptr-1", "UTC");

    expect(pulseMmr.calls).toHaveLength(1);
    expect(pulseMmr.calls[0].opts).toEqual({ preferredRegion: "NA" });
    expect(out.region).toBe("NA");
    // The PTR game is region-unknown to the cross-region guard, so the NA
    // anchor (and with it the session delta) survives it.
    expect(out).toMatchObject({ mmrStart: 4000, mmrCurrent: 4050 });
    expect(out).toMatchObject({ games: 2, wins: 2, losses: 0 });
  });

  test("a PTR handle in the saved pulse ids is skipped by the cold-start region scan", async () => {
    await db.games.insertOne(sessionGame("u-ptr-2", "ptr", 10, PTR_ME));
    const pulseMmr = pulseStub({ mmr: 5100, region: "EU" });
    const svc = new GamesService(db, {
      users: { getProfile: async () => ({ pulseIds: [PTR_ME, "2-S2-1-555"] }) },
      pulseMmr,
    });

    const out = await svc.todaySession("u-ptr-2", "UTC");

    expect(pulseMmr.calls[0].opts).toEqual({ preferredRegion: "EU" });
    expect(out.region).toBe("EU");
  });

  test("without SC2Pulse, a PTR MMR game never labels the widget PTR", async () => {
    await db.games.insertMany([
      sessionGame("u-ptr-3", "na", 90, NA_ME, { myMmr: 4000 }),
      sessionGame("u-ptr-3", "ptr", 10, PTR_ME, { myMmr: 3200 }),
    ]);
    const svc = new GamesService(db, {
      users: { getProfile: async () => ({ region: "na" }) },
    });

    const out = await svc.todaySession("u-ptr-3", "UTC");

    expect(out.region).toBe("NA");
    // Known trade-off: with no SC2Pulse rating, the latest replay MMR
    // (the PTR game's) is the current value against the NA anchor.
    expect(out).toMatchObject({ mmrStart: 4000, mmrCurrent: 3200 });
  });

  test("PTR games between NA games neither anchor nor update the NA MMR delta", async () => {
    await db.games.insertMany([
      sessionGame("u-ptr-4", "na-1", 90, NA_ME, { myMmr: 4000 }),
      sessionGame("u-ptr-4", "ptr", 60, PTR_ME, { myMmr: 3000 }),
      sessionGame("u-ptr-4", "na-2", 10, NA_ME, { myMmr: 4050 }),
    ]);
    const svc = new GamesService(db);

    const out = await svc.todaySession("u-ptr-4", "UTC");

    expect(out).toMatchObject({
      games: 3,
      mmrStart: 4000,
      mmrCurrent: 4050,
      region: "NA",
    });
  });
});

describe("sticky-MMR repair ignores PTR as a region", () => {
  let mongo;
  let db;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    db = await connect({ uri: mongo.getUri(), dbName: "users_sticky_ptr" });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (mongo) await mongo.stop();
  });

  function game(gameId, result, date, extra = {}) {
    return {
      gameId,
      date,
      result,
      myRace: "Zerg",
      myBuild: "Zerg - 3 Hatch Before Pool",
      map: "Old Sun Temple LE",
      durationSec: 460,
      opponent: { pulseId: "ptr-opp", displayName: "PtrOpp", race: "Zerg" },
      ...extra,
    };
  }

  test("a PTR replacement clears lastKnownMmrRegion instead of storing PTR", async () => {
    const games = new GamesService(db);
    const users = new UsersService(db);
    const realDate = "2026-06-10T14:14:12.000Z";
    const fakeDate = "2026-06-11T03:57:19.000Z";
    await games.upsert("u1", game("real-ptr", "Defeat", realDate, {
      myMmr: 4200,
      myMmrSource: "replay",
      myToonHandle: PTR_ME,
    }));
    await games.upsert("u1", game("fake", "Victory", fakeDate, {
      myMmr: 4300,
      myMmrSource: "replay",
    }));
    await db.users.insertOne({
      userId: "u1",
      lastKnownMmr: 4300,
      lastKnownMmrAt: fakeDate,
      lastKnownMmrRegion: "NA",
    });
    await games.quarantineResumedReplay("u1", {
      ...game("fake", "Victory", fakeDate),
      isResumedFromReplay: true,
    });

    expect(await users.repairLastKnownMmrAfterResumedReplay("u1")).toBe(true);
    const repaired = await db.users.findOne({ userId: "u1" });
    expect(repaired).toMatchObject({ lastKnownMmr: 4200, lastKnownMmrAt: realDate });
    expect(repaired.lastKnownMmrRegion).toBeUndefined();
  });
});
